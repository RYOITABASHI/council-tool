# PROTOCOL.md — 首脳会議ツール プロトコル仕様 v9.15

ステータス: Draft（設計中、実装前）— v9.15（Codexレビュー反映・議長裁定反映）
対象読者: コア（事務局エンジン）実装者、表面（MCP/アプリ）実装者

本書は「確定済みの設計判断」を、実装可能な粒度の仕様に落とす。用語・状態機械・データ形式を定義する。

---

## 0. 用語

| 用語 | 意味 |
|---|---|
| 会議 (meeting) | 1つの議題について開始から人間の最終承認までの単位。 |
| 席 (seat) | 会議に参加する個々のAI参加者。接続手段・利用条件・能力・文脈契約の組で定義される（PRODUCT.md参照）。 |
| 議長 (chair) | 会議の進行役。固定モデルではなく役割。人間が議長を兼務することも可。 |
| ラウンド (round) | R0, R1, R2。バリア同期の単位。 |
| パケット (packet) | 1つの発言単位（ある席の、あるラウンドでの回答、または議長の統合）。 |
| 事務局エンジン (core) | 会議の状態機械・配布・転記内容の確認を担うコア。表面（MCP/アプリ）から独立。 |
| 速報 (flash) | バリア未成立の状態で出す暫定の第一感。本答と明示的に区別される。 |
| 本答 (formal) | バリア同期後に確定する、そのラウンドの公式回答。 |

---

## 1. 会議の遷移

### 1.1 正規の流れ（唯一のパス）

会議は以下の一本道でのみ進行する。分岐はR1後の議長ゲートのみであり、それ以外に状態図上の分岐は存在しない。

```
create_meeting（topicを引数で受領）
  → CREATED
  → OPEN(R0)                         ... 議長が open_round を呼び、会議設定を凍結して開始
  → BARRIER(R0)                      ... すべての必須席が received/absent/waived に確定
  → GATE(R0)                         ... 議長の open_round 待ち
  → OPEN(R1)                         ... 議長が open_round を呼び、R0受領分を差分配布の対象として開始
  → BARRIER(R1)                      ... すべての必須席が received/absent/waived に確定
  → GATE(R1)                         ... 議長のゲート判定待ち
       ├─ Pass ──────────────────────────────────────┐
       └─ Fail → OPEN(R2) → BARRIER(R2) ─────────────┤
  ┌──────────────────────────────────────────────────┘
  └→ SYNTHESIZING
     → AWAITING_APPROVAL
     → APPROVED / REJECTED / （REOPENEDは状態ではない。§1.4参照）
```

R0・R1のバリア成立後はそれぞれ `GATE(R0)`・`GATE(R1)` に入り、議長の次の操作を待つ。R2のバリア成立後は直接 `SYNTHESIZING` へ進む（§1.2）。

議長の `chair_gate` による Fail 判定そのものが `OPEN(R2)` への遷移であり、`gate_decision` パケットの `next_round_scope` が対象論点を指定する。別途 `open_round` を呼ぶ必要はない。

### 1.2 状態の定義

- `CREATED`: 会議作成後、R0開始前。議題（topic、引数で受領）と初期設定が登録され、`update_setup` で設定を変更できる。
- `OPEN(round)`: 当該ラウンドが進行中。席の受領状態は `pending` / `transcribed_pending_attest` / `received` / `absent` / `waived` のいずれか（§4）。
- `BARRIER(round)`: すべての必須席の受領状態が確定（受領・absent・waived のいずれかで埋まった）した時点。状態機械上の遷移先であり、`OPEN` の終端であって独立した外部状態ではない（内部的にラウンド終了を示すマーカー）。成立と同時に当該ラウンドの現行版一式をスナップショットとして凍結する（§4）。
- `GATE(round)`: R0・R1のバリア成立後に限る外部状態。`GATE(R0)` では議長の `open_round` を、`GATE(R1)` では議長の `chair_gate` を待つ。この期間も `note` を投稿できる。
- `SYNTHESIZING`: R1のゲート通過時またはR2のバリア成立時に直接入り、議長の統合提出（`synthesize`、§6）を待つ。
- `AWAITING_APPROVAL`: 統合が人間に提示され、承認待ち。
- `APPROVED`: 会議終了。正本が確定。
- `REJECTED`: 人間が統合を却下。会議は終了するが正本として残る。

R0・R1 が開始操作内で即時凍結する場合、会議はそれぞれ `GATE(R0)`・`GATE(R1)` で議長操作を待つ（§4.1）。

コアは会議が `GATE(R1)` の間だけ `chair_gate` を受理する。判定を `gate_decision` として記録すると同時に、Pass なら `SYNTHESIZING` に遷移し、Fail なら `OPEN(R2)` に遷移する。Fail で開いた R2 がその操作内で即時凍結する場合は、同じ操作で `SYNTHESIZING` へ進む（§4.1）。コアは `result: "pass"` と `r2_deadline` の同時指定を `invalid_argument` として拒否する。遷移後の再呼び出しは、会議が `GATE(R1)` ではないため拒否する。

`note` を投稿できるのは会議が `CREATED`・`OPEN`・`GATE(round)`・`SYNTHESIZING`・`AWAITING_APPROVAL` の間に限る。コアは `APPROVED`・`REJECTED` での投稿を拒否する。reopen の場合は新会議に投稿する。（§8.1）

`round_state` は `{ round, phase: "open" | "frozen", opened_at, deadline_at, quorum }` の JSON オブジェクトとする。 `round` は `R0` / `R1` / `R2` のいずれかとし、`phase` はラウンド開始からバリア成立までは `"open"`、凍結後は `"frozen"` とする。`opened_at` は API 応答フィールド専用の名前であり、ラウンドの開始を記録した時点で保持した壁時計の対応値を返す。相対締切と当該ラウンドの `OPEN` 期間の会議タイムアウトの起点には、開始操作の処理時点で取得した内部の開始時刻（単調時計値）を使う（§1.5・§4.1）。`deadline_at` は確定した締切時刻（締切なしの場合は `null`）とし、時刻は保持した壁時計の対応値から ISO 8601 文字列として返し、後の時計ペアで再計算しない（§4.1）。`quorum` は §4.1 で決まる値（未設定の場合は `null`）とする。`round_states` は開始済みラウンドの `round_state` の配列とする。 `reception_table` の各行の `reason` は `{ code, text }` または `null` とする（§4）。

### 1.3 create_meeting / update_setup / open_round

- `create_meeting` は topic（議題文字列）を引数として必須で受け取る。
- `create_meeting` は会議を `CREATED` で作成する。コアは会議が `CREATED` の場合に限り、議長 principal による R0 の `open_round` を受理し、`OPEN(R0)` に遷移させる（§8.1）。R0開始時点で人間参加者（人間の召集者・人間議長・`human_participants` に登録された人間）が0人なら、コアは `council.open_round` を拒否する。R0開始の `open_round` 呼び出しでも `deadline` を指定でき、呼び出し時指定が保存設定に優先する（§4.1）。
- `council.update_setup` は `CREATED`（R0開始前）の間だけ、召集者または議長の principal が呼び出せる。議長（`chair`）・登録する人間参加者（`human_participants`）・席構成・クォータ（§9）・文脈契約・共通資料・ラウンド別設定（`round_settings`）・トップレベルの `quorum`・`meeting_timeout` を更新できる。コアは、保存済みの値も含めて更新後の設定全体を検証する。更新後の設定に無効な値が残る場合は、呼び出し全体を拒否し、変更を部分適用しない。呼び出し側は問題のある設定の修正値を同じ呼び出しで渡す。共通資料を変更した場合、コアは現行の `agenda` の `packet_id` を `supersedes` に指定した新版に差し替える。reopen で継承した設定の変更にも使う。R0開始時に設定は凍結され、以後の呼び出しはコアが拒否する。

  `chair` は部分オブジェクトとし、指定されたフィールドだけを更新する。`seats` の各エントリは必須の `seat_id` で既存の席と照合し、一致する席では指定されたフィールドだけを更新する。新しい `seat_id` のエントリは席の追加とし、作成時の必須フィールド（`seat_id`、`principal`、`connection`）がそろわなければ `invalid_argument` を返す。配列から省いた席は残る。v1 では `update_setup` で席を削除できない。

  席の作成時（`create_meeting` または `council.update_setup` による席の追加時）に `quota` を省略した場合は、接続種別の既定値を具体的な整数として設定に保存する。保存済みの各席の `quota` は常に具体的な整数とする。既存席の `council.update_setup` で `quota` を省略した場合は、保存値を保持し、既定値は再適用しない。接続種別を変更するときは、保存済み設定を参照し、更新後の設定全体を新しい接続種別の制約で段階 (2) において再検証する。省略により保持した `quota` が新しい種別の上限を超える場合、更新は `invalid_argument` で拒否する。変更を通すには、同じ更新で新しい種別の範囲内の `quota` を明示する必要がある。（§9）

  更新時に渡した `seats` 配列が更新前の全席の `seat_id` を含む場合は、新規席も含めて、その配列の順序を更新後の全体の並びとする。一部の既存席を省いた部分更新では、指定された既存席も現在の位置を保ち、新規席は更新配列での出現順に末尾へ追加する。既存席の並び替えは、更新前の全席を指定した場合に限る。

  素のオブジェクトだけをフィールド単位でマージし、省略したフィールドは現在の値を保持する。この規則は `round_settings` の各ラウンドにも適用する。スカラー、タグ付き共用体、および `seats` 以外の配列は値全体を置き換える。異なる方式の `deadline` を指定すると、旧方式のフィールドは破棄される。

  明示的な `null` は、作成型に `null` が含まれるフィールドだけが更新でも受け付ける。`null` を受け付けないフィールドに指定すると `invalid_argument` を返す。 `shared_materials`、`human_participants`、`round_settings`、`quorum`、`meeting_timeout` への `null` も `invalid_argument` とする。消去できるコレクションには、その型に応じた空の配列または空のオブジェクトを渡す。例えば、`shared_materials` と `human_participants` は `[]` で消去する。フィールド単位でマージする `round_settings` に `{}` を渡した場合は、既存の設定を保持する。 作成型では `chair.display_name` を任意の `string | null`、各ラウンドの保存設定の `deadline` を任意の `Deadline | null` とし、それぞれ `null` は未設定を表す。階層ごとの可否は PRODUCT.md §3 の表を参照する。

- 配布世代 `delivery_epoch` は会議と `seat_id` の組ごとに会議の存続中は単調に増加し、値を再利用しない。未使用の `seat_id` の初期値は 1 とする。（§4.2）
- `council.update_setup` で席の `principal` または `driver_principals` の集合が変わった場合、その席の配布世代 `delivery_epoch` を増やし、配布済み・ack 済みの記録を消去し、全パケットを未配布に戻す。旧主体による ack は無効となり、更新後に認可された主体に現行設定と取得時の認可範囲に従って再配布する。（§4.2）
- 会議は整数の `setup_version` を持つ。`create_meeting` で 1 に初期化し、`council.update_setup` が成功するたびに 1 加算する。`council.get_state` は応答のスナップショットの `setup_version` を返す（§4.2a）。共有確認の有効性は §4.2a に従う。
- `create_meeting` / `council.update_setup` では、ラウンド別の締切とクォーラムを `round_settings: { R0?: { deadline?, quorum? }, R1?: { deadline?, quorum? }, R2?: { deadline?, quorum? } }` で渡す。ラウンド別の `quorum` は任意で、未指定のラウンドにはトップレベルの `quorum` を既定値として適用する。`quorum` は受領集計で達成と判定するために必要な必須席の受領数を表す。`create_meeting` / `council.update_setup` のどちらでも、設定するクォーラムの値はトップレベルとラウンド別のいずれも1以上かつ席数以下の整数とする。
- 締切は、呼び出し時指定、当該ラウンドの保存設定、直前ラウンドで解決された相対期間の継承、締切なしの順で決定する（§4.1）。継承する相対期間は当該ラウンドの開始時刻に再アンカーし、ラウンド間で絶対締切は継承しない。R2の締切規則はこの一般形の特殊ケースとする。
- `council.open_round` の `deadline` はR0・R1の開始時に指定でき、§4.1 の決定順序に従う。`council.open_round` では、どのラウンドにも `quorum` を指定できない。
- コアは会議が `GATE(R0)` の場合に限り、議長 principal による R1 の `open_round` を受理し、`OPEN(R1)` に遷移させる（§8.1）。
- R2は `chair_gate` の Fail 判定で直接開く。対象論点は `gate_decision` パケットの `next_round_scope` に含まれ、別途 `open_round` を呼ぶ必要はない。
- `update_setup` と `open_round` の `invalid_state` では、`detail` に `meeting_state` を含め、必要に応じて `round` を追加する（§4.3）。
- 会議作成後にユーザー/議長が送る追加発言は、議題そのものではなく「議長への指示」として扱う（PRODUCT.md §4）。

### 1.4 reopen — 却下と新会議作成の一括操作

- `decision: "reopen"` の場合、`reopen_points` は必須かつ非空の文字列配列とし、省略または空配列での呼び出しはコアが拒否する。`reopen_points` には、元会議の最終 `gate_decision` の `unresolved_points` から選んだ文字列をそのまま、`synthesis` の `minority_opinions` から選んだ意見はその本文文字列を、自由入力は入力した文字列を渡す。これらは混在できる。
- 当該会議の人間参加者が `AWAITING_APPROVAL` で `council.approve` の `decision: "reopen"` を選ぶと、元会議を理由 `reopened` で `REJECTED` に確定し、同じ操作で新会議を作成する（§8.1）。新会議の召集者は reopen を実行した人間（`council.approve` の呼び出し主体）とする。新会議は `reopens: "<元のmeeting_id>"` を持つ。新会議の `agenda.topic` は `reopen_points` の要素を順に「 / 」で連結した文字列とする。
- 新会議は `CREATED`、`setup_version: 1` で作成し、元会議の議長・`human_participants`・席構成・文脈契約・共通資料を既定で継承する。元会議の各席のクォータ（`quota`）とラウンド別設定（`round_settings`）・トップレベルの `quorum`・`meeting_timeout` の設定値を継承する。評価済みの時刻は引き継がず、相対締切は§4.1 の締切の決定順序に従って新会議の該当ラウンドの開始時刻に再アンカーする。召集者または議長の principal は `CREATED` の間に `council.update_setup` で継承した設定を変更できる。
- 継承した絶対締切は §4.1 の一般規則に従って評価する。
- 新会議のラウンド番号は `R0` から採番する。会議履歴は `council.get_state` 等で `reopens` リンクを辿る。

### 1.5 会議全体タイムアウト

- `meeting_timeout` は秒単位の正の整数とし、`create_meeting` / `council.update_setup` で指定できる。既定値は 259200 秒（72時間）。0以下の値と非整数は拒否する。仕様上の上限は定めない。`council.update_setup` で変更できるのは `CREATED` の間に限る（PRODUCT.md §3・§5）。
- タイムアウトが適用されるのは各ラウンドの `OPEN` 期間およびバリア成立後の議長操作待ち期間（R0後の `open_round` 待ち・R1後のゲート判定待ち・R2後の `synthesize` 待ち）に限る。各ラウンドの `OPEN` 期間の起点は内部の開始時刻（単調時計値）とする。議長操作待ち期間の起点は、バリアを成立させた項目の処理時点における単調時計の読み値とする。スイープが成立させた場合も、論理上の締切 T ではなく、そのスイープの処理時点を起点とする。R2後の統合待ちは `SYNTHESIZING` での議長操作待ちにあたり、期限到達時は下記のフラグ設定と通知のみを行う。R1のゲート通過後の統合待ちと `AWAITING_APPROVAL` には適用しない。
- コアは単一の単調時計を持ち、操作の登録を直列化する。操作の受信時刻は登録時の単調時計の読み値とする。締切やタイムアウトの時刻比較はすべてこの時計の値で行う。「処理時点」は、全体順序の中で当該操作またはスイープを処理する位置での単調時計の読み値を指す。受信時刻は順序づけと初回提出・初回転記の締切適格性の判定に用い、状態変更が効力を持つ時刻は処理時点に統一する。内部の開始時刻（単調時計値）は開始操作の処理時点とする。変換を行うステップで同時に読み取った時計ペア（壁時計値、単調時計値）からオフセットを導く。変換した締切の単調時計値は確定し、再計算しない。絶対締切の変換は §4.1 に従う。
- 会議タイムアウトの判定時刻は、各ラウンドの `OPEN` 期間と各議長操作待ち期間のそれぞれについて、「その期間の開始時刻＋`meeting_timeout`」と「会議作成時刻＋`meeting_timeout`」のうち遅い方とする。会議作成時刻から数えた期限を過ぎて開いたラウンドにも、開始時刻を起点とする判定時刻を適用する。
- コアはパケット提出（`submit_answer`、`transcribe_web_seat`、`submit_attest` を含む）、`waive_seat`、`declare_absent`、議長操作を含むすべての状態変更操作をコア受信順に処理する。ラウンド締切時刻と会議タイムアウト判定時刻は、それぞれのスイープを全体順序に置くために使う。スイープの時刻を T とする。時刻 T のスイープは、受信時刻が T 以下のすべての操作の後、受信時刻が T より大きいすべての操作の前に置く。この全体順序上の位置はタイマー項目の登録時期に依存しない。受信時刻が T より大きい操作は常に対象スイープ後の状態で判定する。各時刻では種別を主キーとし、(i) その時刻以下の受信タイムスタンプを持つ未処理の操作、(ii) その時刻のラウンド締切スイープ、(iii) その時刻の会議タイムアウト評価、の順に処理する。すべての時刻検証は、全体順序で当該操作を処理する位置で行う。検証に使う時刻は各規則に従う。これには `open_round` と `chair_gate` で指定する絶対締切の上書きの検証も含む。同時刻の操作同士は登録順、同時刻・同種のスイープ同士は生成順とする。上書き締切が処理時点と一致する場合、新設のラウンド締切スイープは、同時刻に処理済みまたは投入済みの同種の項目すべての後、投入済みの同時刻の会議タイムアウト評価より先に置く。ラウンド締切スイープは、全体順序上の自らの処理位置での状態に作用する。その位置では、受信時刻が締切以前（同時を含む）の操作はすべて処理済みである（§4.1）。
- 会議タイムアウト評価項目は、評価を予定した個々のラウンドの `OPEN` 期間または議長操作待ち期間の実体にひも付ける。全体順序上で評価項目を処理する位置において、その対象期間がすでに終了していれば何もしない。対象期間が現行であれば、評価項目の予定時刻（論理時刻）がその期間の起点＋`meeting_timeout` 以上かどうかで判定する。
- 会議タイムアウト時はコアが `timeout_exceeded` フラグを立て、`get_state` で返す。表面は会議スレッド内のシステム表示で知らせる。席の受領状態や提出の受理可否には影響しない。フラグは会議に一度立てば残る。プッシュ通知や強制遷移は行わない。

---

## 2. ラウンドプロトコル

全必須席が終端の受領状態（`received` / `absent` / `waived`）に達した時点で、締切の有無・到来やクォーラムの充足を問わずバリアを凍結する。コアは凍結時に `quorum_met` を計算し、受領集計に記録する。締切スイープは席を終端状態にする一手段である。締切がなく必須席が未確定のままなら、バリアは成立せず会議は待機する。議長は免除（`waive_seat`）または欠席宣言（`declare_absent`）で未確定の席を終端状態にできる。 attest 未確定で `transcribed_pending_attest` の必須 Web 席も未確定として扱う。任意席はバリア成立を妨げない（§4.1・§6）。成立時に現行版一式を凍結し、以後は、先行する段階の検査を通過した場合に限り、当該ラウンドへの提出・差し替え・attest を「凍結後」として拒否し、その事実を記録する（§4）。`supersedes` の照合で不正が判明した場合、コアは先に段階 (2) で `invalid_argument` を返し、その試行を引数拒否として監査記録する。凍結後拒否としては記録しない。

全ラウンドの本答・批評（R1の批評を含む）では、各主張の「判断が変わる条件」を回答形式の必須要素とする。この条件や構造化記載が欠ける提出も §3.2–3.3 の寛容経路で受理し、§3.3 に従って欠落を記録して進める。欠落自体は拒否事由としない。

### R0 — 独立回答
- 全席に同一の議題パケットを配布。
- 独立回答を担保するため、R0の参加席である principal は、議長を兼ねていてもバリア(R0)成立までは他席のR0回答を読めない。席入力としての配布と召集者・議長・人間参加者の監督ビューの認可は §4.2a に従う。R0にも §5 の速報規則を適用する。

### R1 — 相互批評
- `GATE(R0)` で議長 principal が `open_round` を呼び、コアがR1を開く（§1.3）。
- R1開始時、R0の凍結済みスナップショットの受領分を差分配布の対象とする（§4.2）。
- 各席は他席の回答に対する批評・補強・反論を提出する。

### 議長ゲート（Chair Gate）

`chair_gate` の `invalid_state` では、`detail` に `meeting_state` を含め、必要に応じて `round` を追加する（§4.3）。
議長による合意判定はR1後にのみ行う。議長は以下を判定する。

1. **合意判定**：主要論点について席間の実質的対立が解消しているか。
2. **通過（Pass）**：R2を実施せず `SYNTHESIZING` へ進む。
3. **不通過（Fail）**：未解決の論点を列挙し、`chair_gate` の Fail 判定で直接 `OPEN(R2)` に遷移する。対象論点は `gate_decision` パケットの `next_round_scope` で指定し、別途 `open_round` を呼ぶ必要はない。R2は最大1ラウンドで、ゲートの再実行はない。

コアは `chair_gate` の `result: fail` に対し、`next_round_scope` と `unresolved_points` の両方が非空でなければ呼び出しを拒否する。コアは `result: "pass"` と `r2_deadline` の同時指定を `invalid_argument` として拒否する。Fail 時は任意引数 `r2_deadline` に絶対時刻または相対時間を指定でき、締切の決定と検証は §4.1 に従う。

ゲート判定自体もパケットとして記録される（kind: `gate_decision`、§3参照）。指定論点に加え、`chair_gate` の任意引数 `rationale` で渡した判定理由を本文の必須フィールド `rationale` に格納する。引数を省略した場合は空文字列を格納する。

### R2 — 限定ラウンド（条件付き）
- 議長が指定した論点のみを対象に、各席が追加回答する。
- R0/R1と同じ受領状態機械・バリア同期を使う。
- R0・R1・R2の保存設定の絶対締切は、設定時点で過去でも登録でき、§4.1 に従ってラウンド開始時に評価する。R2の締切は §4.1 の決定順序に従う。
- R2の開設時点でゲート判定は済んでいる。指定論点の解決専用のR2は、バリア成立時に直接 `SYNTHESIZING` へ進む。議長の統合提出を待つ間は、会議タイムアウトのフラグ設定と通知の対象とする（§1.5・§6）。
- **R2後も席間の不合意が残る場合**：それを理由に会議を留める状態は存在しない。不合意点は統合の `minority_opinions`（少数意見）として残す。「不合意終了」という独立状態は設けない。

---

## 3. パケット仕様

### 3.1 ヘッダ

全パケットは以下のヘッダを持つ：

```json
{
  "meeting_id": "string (UUID)",
  "round": "R0 | R1 | R2 | null",
  "seat_id": "string | null (議題・議長統合・ゲート判定・追加発言はnull)",
  "kind": "agenda | answer | critique | flash | gate_decision | synthesis | attest | note",
  "packet_id": "string (UUID)",
  "packet_sha": "string (sha256 hex, 64 chars)",
  "created_at": "string (UTC, ミリ秒固定書式 'YYYY-MM-DDTHH:mm:ss.sssZ'。例: '2026-11-20T07:33:46.285Z')",
  "supersedes": "string | null (差し替え先の packet_id)"
}
```

コアはパケットの受理時に一意の UUID を `packet_id` として割り当てる。同一内容の投稿も別々の `packet_id` を持つ別パケットとして受理し、重複排除は行わない。配布・ack・パケットへの参照の主キーは `packet_id` とする。

`gate_decision` の `round` は `"R1"`、`agenda` / `synthesis` / `note` の `round` は `null`（会議レベル）とする。

`attest` のヘッダでは、`meeting_id` は当該会議の ID、`round` は対象転記版のラウンド、`seat_id` は対象 Web 席の `seat_id`、`kind` は `attest`、`supersedes` は `null` とする。`created_at` は §3.4 の通常規則に従う。対象転記版と attest パケットの関連付けはコアの確定記録に保持する（§4.3）。`get_packets` の両ビューでは、`attest` パケットの応答上のオブジェクトに、対象転記版の `packet_id` を示す文字列 `target_packet_id` をメタデータとして付ける。値はコアの確定記録から取得する。`attest` パケットには常に付け、他の kind のパケットでは省略する。attest 本文は §3.2 の固定形のままとする。`evidence.target_packet_id` は `submit_attest` 呼び出し時の入力を指す名前に限る。attest は対象転記版の差し替えではない（§4.3）。

### 3.2 本文（kind別）

- **agenda**（議題）：
  ```json
  {
    "topic": "string",
    "shared_materials": ["string (共通資料への参照ID)"]
  }
  ```
  `create_meeting` は会議作成時に `agenda` を保存する。共通資料の参照IDは文脈契約と同じ表現を使い（PRODUCT.md §2.2）、省略時は空配列とする。全参加主体が認可されたビューで取得できる（§4.2a）。 席のひも付けがない当該会議の召集者・議長・人間参加者は、`view: "oversight"` を明示し、`caller_seat_id` に議長としては `"chair"`、人間参加者としては `"human"`、召集者としては `"convener"` を指定する。コアは指定されたロールを認証済み principal と照合する。配布と ack の単位となる席がないため、コアは席のひも付けがない principal の `input` 呼び出し（`view` 省略時を含む）を拒否する。議長が `input` を使う場合は、本人または認可ドライバとしてひも付く当該会議の席の `seat_id` を `caller_seat_id` に指定する。

- **answer**（R0/R2の回答）、**critique**（R1の批評）：
  ```json
  {
    "body": "string (本文, markdown可)",
    "claims": [
      {
        "statement": "string",
        "reversal_condition": "string (判断が変わる条件)"
      }
    ]
  }
  ```
  `claims` による構造化は推奨とし、構造化フィールドが一切ない自然文のみの本答・批評も受け付ける。回答形式として各主張の「判断が変わる条件」を `claims` または本文に明記する。構造化記載や条件自体が欠ける場合の受理と記録は §3.3 に従う。`claims` の各要素で欠落検出の対象とするフィールドは `statement` と `reversal_condition` の2つに限る。段階 (0) の形式検査では、両フィールドについて省略、`null`、空文字列または空白のみの文字列をいずれも受理する。

  欠落判定で用いる空白は、Unicode の White_Space プロパティを持つ文字の集合（U+0009–U+000D、U+0020、U+0085、U+00A0、U+1680、U+2000–U+200A、U+2028、U+2029、U+202F、U+205F、U+3000）とする。文字列の全文字がこの集合に属する場合に「空白のみ」と判定する。空文字列もこの判定に含める。

- **flash**（速報）：
  ```json
  { "body": "string", "basis": "string (何を踏まえた暫定かの明記。例: 'R0の受領2/4時点')" }
  ```
  `flash` の統合（synthesis）での引用適格性は §6 に従う。表面への表示は「暫定」のラベル必須（§7）。

- **gate_decision**：
  ```json
  {
    "result": "pass | fail",
    "rationale": "string",
    "resolved_points": ["string"],
    "unresolved_points": ["string"],
    "next_round_scope": ["string"]
  }
  ```

  `rationale` は必須の文字列フィールドとする。`chair_gate` で省略された場合は空文字列を入れる。`resolved_points`、`unresolved_points`、`next_round_scope` は本文に常に含める。コアは `chair_gate` で省略された配列引数を空配列 `[]` として格納し、キーを省略しない。Fail 時は `unresolved_points` と `next_round_scope` の両方が非空でなければ呼び出しを拒否する（§2）。

- **synthesis**（議長統合）：§6参照。

- **attest**（Web 席の転記内容の確認、§4.3）：
  `verbatim_confirm` の本文例

  ```json
  {
    "method": "verbatim_confirm",
    "result": "confirmed"
  }
  ```

  `hash_match` の本文例

  ```json
  {
    "method": "hash_match",
    "result": "confirmed",
    "source_hash": "185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969"
  }
  ```

  v1 のコアは `verbatim_confirm` のみを受理する。`method=hash_match` の `submit_attest` は、v1 の許容値の範囲外として段階 (0) で `invalid_argument` を返す。`hash_match` の判定規則は後継版の仕様とする（§4.3）。

  attest パケットの本文は方式ごとに固定形の JSON オブジェクトとする。`verbatim_confirm` は `{ method, result }`、後継版の `hash_match` は `{ method, result, source_hash }` とする。`source_hash` は `hash_match` で必須とし、`verbatim_confirm` では禁止する。方式ごとの入力スキーマにない余分なフィールドは段階 (0) で `invalid_argument` として拒否する（§4.3）。

  本文の入力オブジェクトは、`submit_attest` の必須引数 `method` と申告 `result`（`confirmed` / `mismatch`）、および `hash_match` の場合は `evidence.source_hash` の値で構成する。保存本文はこの入力オブジェクトそのものとし、キーや値を変えずに §3.4 のハッシュ規則で正規化する。`result` は `evidence` の外で受け取り、コアの確定結果と異なる場合も申告値を保存する。正規化された本文と同節で定めるヘッダから `packet_sha` が決定的に定まる。

  後継版の `hash_match` の証拠突合は、対象が attest 適格な種別（本文を持つ転記版）の場合に限り段階 (2) で行う。不適格な種別は段階 (2) で突合せず、認可を通過した対象は段階 (4) で `invalid_state` として拒否する。`detail` は §4.3 の `submit_attest` のキーに従い、対象が版でなければ `target_reception_state` は `null` とする。

- **note**（会議中の追加発言）
  ```json
  { "text": "string" }
  ```
  当該会議の人間参加者と議長は、本文 `{ text }` を渡して `council.post_message` で `note` を投稿できる。`get_packets` では会議レベルのパケット（`round: null`）として取得できる。投稿可能な状態と席への配布条件は §1.2・§4.2a・§5 に従う。用途は議長への指示・補足に限る軽量な経路とし、チャットシステムにはしない。（§4.2a・§8.1）

### 3.3 判断が変わる条件（reversal_condition）

全ラウンドの本答・批評（R1の批評を含む）で、各主張の「判断が変わる条件」は回答形式の必須要素とする。構造化する場合は各 `claim` の `reversal_condition` に記載する。自然文のみの提出や必須要素が欠けた提出も受理する。§3.2 で列挙した `statement` と `reversal_condition` は、それぞれ省略・`null`・§3.2 の定義による空白のみの文字列（空文字列を含む）のいずれかであれば欠落とする。段階 (0) では両フィールドの省略・`null`・空文字列をいずれも受理し、コアはバリア凍結時に、凍結済み受領版の欠落（`statement` の欠落を含む）を当該版の `missing_records` に記録する。

構造化フィールドを持つ提出は、`claims` が空配列でも構造化提出として扱う。コアは `claims` が空配列の場合や、`statement` または `reversal_condition` が §3.3 の判定で欠落した主張がある場合に、欠落を機械的に検出し、凍結済み受領版について、その版にひも付けて記録する。`missing` には、欠落した構造化提出のスキーマに定義されたフィールド名をそのまま使い、版ごとに重複なく（集合として）記録する。v1 では主張ごとの粒度は記録しない。たとえば、`claims` が空配列なら `missing: ["claims"]` と記録し、ある主張で両フィールドが欠落していれば `missing: ["statement", "reversal_condition"]` と記録する。

自然文経路は構造化フィールドが一切ない提出にのみ適用する。自然文のみの回答では、議長が統合作成時に読み取り、欠落があれば、対象版を `packet_id` で特定する `{ seat_id, packet_id, note }`（各値は文字列）の形で、提出する `missing_records` に含める。コアは、議長が申告した欠落記録について、`packet_id` が当該ラウンドの `seat_id` に対応する凍結済み受領版を指すこと、およびその受領版が構造化フィールドを一切持たない自然文の提出であることを検証し、両方を満たす有効な記録だけを `{ seat_id, packet_id, note }` の形で統合の `declared_missing_records` に保存する。凍結された受領版に一致しない申告や、構造化提出を対象とする申告は破棄し、監査ログに記録する。構造化提出ではコアの機械的な欠落記録を優先する。コア生成の欠落記録は、バリア凍結時点の現行版のうち、凍結済み受領版についてのみ保存する。これにより、統合に入る欠落記録をバリア凍結時点の現行版に限る規則が、自然文由来の記録にも機械的に適用される。構造化提出の欠落記録はコア生成と分かる形で記録する。差し替え済みの旧版の欠落記録は保存しない。議長が宣言しなかった自然文の欠落は記録されず、その判定と宣言は議長の責任とする。（§6）

コアは欠落を理由に拒否せず、議長による差し戻しも行わずに進める。

### 3.4 packet_sha の正規形

内容の同一性・完全性の確認に `packet_sha` を使う。`packet_id` は配布順の `seq` と同様に計算対象外とする。`packet_sha` が保証するのは、信頼できる経路で得たハッシュ値とパケットの内容が一致することまでである。主体の識別には認証済み principal を用い、attest は転記内容の確認を担う。暗号学的署名・鍵ペアは使用せず、PRODUCT.md でも「ハッシュ計算」に用語を統一する。

**計算対象**：以下の形の値を正規化してシリアライズしたもの。

```json
{ "header": { ... ヘッダから packet_sha と packet_id を除いたもの（配布順の seq も含めない） ... }, "body": { ... 本文全体（§3.2） ... } }
```

**正規化規則**：RFC 8785 (JSON Canonicalization Scheme) に従う。以下はJCSの要点とハッシュの計算手順。 [RFC 8785 §3](https://www.rfc-editor.org/rfc/rfc8785.html#section-3)

1. 入力はI-JSONの制約に従う。重複するプロパティ名を認めず、文字列にUnicode正規化を施さない。
2. 全オブジェクトのキーを、エスケープ前のUTF-16コード単位の値で辞書順にソートする。配列内のオブジェクトも対象とし、配列の要素順は維持する。
3. JSONのプリミティブ値はRFC 8785 §3.2.2に従いシリアライズする。JSONトークン間に空白を挿入せず、文字列内の空白は値の一部として保持する。
4. `null` は明示的に保持する。省略されたキーはシリアライズに現れず、`null` 値のキーは `"key":null` として現れる。
5. シリアライズ結果をUTF-8でエンコードし、得られたバイト列に対するSHA-256を16進小文字64文字で表す。

**created_at の扱い**：パケット生成時に1度だけ確定し、以後不変（再配布・差分配布で変わらない）。これにより同一内容の再配布は同一 packet_sha を持つ。書式は上記3.1の通りUTCミリ秒固定（例: `2026-11-20T07:33:46.285Z`）とし、タイムゾーンオフセット表記やミリ秒省略は許可しない。

`attest` の `packet_sha` は、§3.1 で割り当てたヘッダ（`supersedes: null` を含み、上記の共通除外項目を除く）と、申告 `result` を含む §3.2 の本文全体から計算する。

**`<untrusted>` ラップとの関係**：§8で定義する `<untrusted>...</untrusted>` 相当のラップは配布時にコアが付与する表示・転送上の処理であり、保存されたパケット本文やヘッダの一部ではない。したがって packet_sha の計算対象には含まれない（ラップの有無に関わらず同一パケットは同一 packet_sha を持つ）。

**本文の書き換え**：本文を書き換える場合（Web 席の手動修正等）は新パケットとして扱う。`submit_answer` と `transcribe_web_seat` は任意引数 `supersedes?: string | null` を持つ。明示的な `null` は省略とまったく同じ扱いとする。版照合は両操作に共通で、認可後の段階 (2) で行う（§4.3）。当該ラウンド・席に現行版があればその `packet_id` を照合先とする。attest 不一致で現行版がなければ、受領表の `invalidated_packet_id` が指す版を照合先とする（§4）。照合先がある場合は一致する ID の指定を必須とし、指定の欠落や不一致は `invalid_argument` として版連鎖の分岐を防ぐ。照合先がない初回提出・初回転記では、非 `null` の指定を `invalid_argument` とする。対象ラウンドが凍結済みでも段階 (2) の照合を先に行い、照合エラーに `detail` は不要とする。対象席が存在しない場合は照合せず段階 (3) へ進む。提出経路の適格性（接続種別）は段階 (4) で判定する。

#### テストベクタ（検証用の具体例）

以下のテストベクタは packet_sha のハッシュ計算の検証専用であり、回答パケットの内容要件（判断が変わる条件等）を満たす例ではない。ブロック末尾の改行はハッシュに含めない。

計算対象のヘッダ（`packet_sha`・`packet_id`・`seq` を除外）：
```json
{"created_at":"2026-11-20T07:33:46.285Z","kind":"answer","meeting_id":"123e4567-e89b-12d3-a456-426614174000","round":"R0","seat_id":"seat_a","supersedes":null}
```

本文：
```json
{"body":"Hello","claims":[]}
```

ハッシュ対象のJCSシリアライズ：
```
{"body":{"body":"Hello","claims":[]},"header":{"created_at":"2026-11-20T07:33:46.285Z","kind":"answer","meeting_id":"123e4567-e89b-12d3-a456-426614174000","round":"R0","seat_id":"seat_a","supersedes":null}}
```

このUTF-8バイト列のSHA-256（16進小文字64文字）：

```
packet_sha = 356ce68553ab4089173f9d849521e857c99f44721c0fb4a9e7a3a119f4a0cbab
```

日本語本文のベクタ（ヘッダは上と同一）：

```json
{"body":{"body":"判断が変わる条件：新しい証拠が出ること。","claims":[]},"header":{"created_at":"2026-11-20T07:33:46.285Z","kind":"answer","meeting_id":"123e4567-e89b-12d3-a456-426614174000","round":"R0","seat_id":"seat_a","supersedes":null}}
```

```
packet_sha = 3d18515e6894ce00d4f31e09940b899da6f105a7039c99bf93160326aa79e636
```

---

## 4. 受領状態機械

コアは `submit_answer`、`transcribe_web_seat`、`submit_flash` の対象ラウンドが会議の現在の `OPEN` ラウンドでなければ、呼び出しを拒否する。`submit_answer` と `transcribe_web_seat` の `invalid_state` では、`detail` に `reception_state`、`round_frozen`、`deadline_eligible` を含める。`submit_flash` の `invalid_state` の `detail` は `{ reception_state, round_frozen }` とする（§4.3）。

ラウンド締切がある場合、本答（`answer` / `critique`）の（ラウンド, 席）ごとの初版は、締切以前（同時を含む）にコアが受信する必要がある。締切後に初めて届いた提出はコアが拒否する。締切内の初版はラウンドが `OPEN` の間に差し替えられる。差し替えは接続種別を問わず初版の締切適格性を継承する（§4.1）。

`absent` / `waived` 等の席の状態による提出制限は、その席としての提出（本答・批評・当該 `seat_id` での速報）にのみ適用する。コアは `absent` / `waived` に確定した席としての提出を拒否する。議長ロールの速報（`seat_id: "chair"`）は、兼務する議長自身の席の状態にかかわらず、対象ラウンドが会議の現在の `OPEN` ラウンドである間は提出できる。

バリア成立時にコアは当該ラウンドの現行版一式をスナップショットとして凍結する。以後、先行する段階の検査を通過した場合に限り、当該ラウンドを対象とする提出・差し替え・attest は「凍結後」として拒否し、拒否した事実を記録する。`supersedes` の照合で不正が判明した場合、コアは先に段階 (2) で `invalid_argument` を返し、その試行を引数拒否として監査記録する。凍結後拒否としては記録しない。

`reception_table` は開始済みラウンドと席の組ごとに1行を持つ JSON 配列とし、各行は `{ seat_id, round, state, reason, current_packet_id, invalidated_packet_id }` とする。 `state` は `pending` / `transcribed_pending_attest` / `received` / `absent` / `waived` の5値の列挙とする。コアはこの値をそのまま保存し、API で返す。`reason` の型は `{ code: string, text: string | null } | null` とする。`waived` / `absent` では定型コードを `code`、自由文を `text` に保持し、自由文がなければ `text` は `null` とする。理由を持たない状態では `reason` は `null` とする。`current_packet_id` は当該席・ラウンドの現行提出版のパケット ID とする。`invalidated_packet_id` は当該席・ラウンドで attest 不一致により直近に無効化された版のパケット ID とする。`current_packet_id`、`invalidated_packet_id` は、それぞれ該当する値がなければ `null` とする。attest 不一致が確定した時点で `current_packet_id` を `null` にし、無効化した版の ID を `invalidated_packet_id` に保存する。現行版がない状態からの再転記では、`supersedes` は `invalidated_packet_id` を参照する。

コアは `open_round` または `chair_gate` の Fail でラウンドを開く際、当該ラウンドの全席の行を `state=pending`、`reason=null`、`current_packet_id=null`、`invalidated_packet_id=null` で初期化する（§4.1）。

各(ラウンド, 席)の組は以下の状態を持つ：

```
pending → received (非 Web 席の本答提出)
pending → transcribed_pending_attest (Web 席の初回転記、または attest 不一致確定後の再転記。§4.3)
pending → absent   (締切スイープまたは議長の欠席宣言。クォーラム判定に影響)
pending → waived   (議長が明示的に免除)
received → transcribed_pending_attest (Web 席の現行版を差し替えた場合。§4.3)
transcribed_pending_attest → transcribed_pending_attest (attest 未確定の現行版を再転記で差し替えた場合。§4.3)
transcribed_pending_attest → received (現行版の attest が confirmed に確定した場合。§4.3)
transcribed_pending_attest → pending (締切スイープ前の attest 不一致。§4.3)
transcribed_pending_attest → absent (締切スイープ後の attest 不一致。`reason.code: attest_mismatch`。§4.3)
transcribed_pending_attest → absent (議長の欠席宣言)
transcribed_pending_attest → waived (議長が明示的に免除。§4.1a)
```

- `transcribed_pending_attest`: Web 席の初回転記または attest 不一致確定後の再転記を受け付けると、`pending` から遷移する（§4.3）。attest 未確定の間に議長が席を免除すれば `waived` に遷移する。
- `received`: 現行版の本答パケットが到着し、Web 席の場合はその版の attest も `confirmed` に確定済み（§4.3）。同じ版への後続の attest は拒否され、席の受領状態は変わらない。
- `absent`: コアが締切スイープ時に `pending` の席に付与する（§4.1）。スイープ後に attest 不一致が確定した席には、その確定時に付与する（§4.3）。議長の欠席宣言を受理した場合にも付与する。`absent` への遷移時に記録する `reason.code` は当該ラウンドにおける席の提出履歴（理由判定でいう提出の定義は §4.1）に基づき、次の表の上から最初に該当する値とする（受領集計の表示との対応は §6）。欠席理由に自由文の入力はないため、`reason.text` は `null` とする。

  | 条件（優先順） | `reason.code` |
  |---|---|
  | 当該ラウンドに attest 不一致で無効化された版がある（締切スイープや議長の欠席宣言で遷移した場合も含む） | `attest_mismatch` |
  | `declare_absent` を受理 | `chair_declared` |
  | 締切スイープ時に `pending` で、当該ラウンドに提出が一切ない | `deadline_no_submission` |

- `waived`: 議長のみが宣言可能。理由の記録を必須とする（§4.1a）。
- 差し替え版は現行版となる。非 Web 席の差し替え版は初版の締切適格性を継承し（§4.1）、提出操作の処理時点で `received` となり、attest は不要。
- ラウンドが `OPEN`（バリア未成立）の間は、`transcribed_pending_attest` の席の現行版は初版から継承した締切適格性がある場合（§4.1）に差し替えられる。Web 席では、差し替え前が `received` でも `transcribed_pending_attest` でも、新版は `transcribed_pending_attest` となり、その版を attest 未確定として扱う（§4.3）。差し替えで会議タイムアウトはリセットされない。

受理された `waive_seat` / `declare_absent` は、現行版の検証状態にかかわらず席の受領状態をそれぞれ `waived` / `absent` にする。版の attest 状態はパケット側の記録に残る。現行版の attest 状態で席の受領状態を判定するのは、席が免除・欠席で終端となる前の `pending`（`transcribed_pending_attest` を含む）または `received` の間に限る。（§4.3）

**議長による欠席宣言（`declare_absent`）**。議長 principal のみが呼び出せる（§8.1、PRODUCT.md §3）。コアは、対象ラウンドが `OPEN` で、対象席が `pending` または `transcribed_pending_attest` の場合にだけ受理し、席を `absent` に遷移させ、上の規則に従って `reason` を記録する。対象ラウンドが `OPEN` でない場合や、対象席がすでに `received` / `waived` / `absent` の場合は拒否する。他の状態変更操作と同じコア受信順序の規則に従う（§1.5・§4.1）。`declare_absent` の `invalid_state` では、`detail` に `reception_state` と `round_frozen` を含める（§4.3）。

### 4.1 締切とクォーラム

コアは記録する各時刻について、記録時に同時取得した時計ペア（壁時計値、単調時計値）に基づく壁時計の対応値を併せて保持する。API が返す ISO 8601 値（`opened_at`、`deadline_at` 等）はその保持値から生成し、後の時計ペアで再計算しない。

- 内部の開始時刻（単調時計値）は、R0・R1 では `open_round`、R2 では Fail 時の `chair_gate` を全体順序の中で処理する位置での単調時計の読み値とする（§1.5）。相対締切と当該ラウンドの `OPEN` 期間の会議タイムアウトは、この時刻を起点とする。
- `deadline` の値は `{ kind: "absolute", at: ISO 8601 タイムスタンプ }` または `{ kind: "relative", seconds: 正の整数 }` のいずれかとする。相対期間の単位は秒とする。`council.open_round` の `deadline` と `chair_gate` の `r2_deadline` にも同じ形式を使う。絶対締切の `at` にはタイムゾーン指定（`Z` または `±hh:mm`）を必須とする。タイムゾーンのないタイムスタンプはローカル時刻として解釈せず、`invalid_argument` で拒否する。
- `create_meeting` / `council.update_setup` では、ラウンド別の締切とクォーラムを `round_settings: { R0?: { deadline?, quorum? }, R1?: { deadline?, quorum? }, R2?: { deadline?, quorum? } }` で渡す。
- 絶対締切は、保存設定なら当該ラウンドの開始時に、呼び出し時の上書きなら当該操作の処理時点に、変換する。ISO 8601 の入力は小数部を含む正確な値として解釈し、時計ペアから導いたオフセットを用いてコアの単調時計の尺度に移す。変換を行うステップで同時に読み取った時計ペア（壁時計値、単調時計値）からオフセットを導く。変換した締切の単調時計値は確定し、再計算しない。元の ISO 8601 値は表示用に保持し、締切の比較はすべて単調時計の尺度で正確に行う。変換および比較では丸めも切り捨ても一切行わない。
- R0・R1・R2の保存設定（`create_meeting` / `council.update_setup` / reopen 継承）の絶対締切は、ラウンド開始時点で未来の場合に限り採用する。それ以外は記録して読み飛ばし、締切の決定順序の次の規則へ進む。締切が決まらなければ、そのラウンドは締切なしとし、会議タイムアウトを別途適用する。設定時点で過去であること自体はエラーにしない。上書き引数（`council.open_round` の `deadline` または `chair_gate` の `r2_deadline`）に当該操作の処理時点（§1.5）より厳密に過去の絶対時刻を指定した場合、時刻差がどれほど小さくてもコアは呼び出しを `invalid_argument` で拒否する。処理時点と同時刻の指定は過去とみなさない。保存設定の読み飛ばし規則は上書き引数には適用しない。受理した上書きによるラウンド締切のスイープは、変換後の締切時刻を使って全体順序に置く。
- 締切入力を伴う操作の検査は、全体順序で当該操作を処理する位置で行う。共通検査順（§4.3）に従い、段階 (0) で書式・タイムゾーン指定を、段階 (2) で処理時点より厳密に過去の上書きを検査する（PRODUCT.md §3）。
- 全ラウンドの締切は次の順序で決定する（会議タイムアウトは §1.5）。
  1. 当該ラウンドを開始する `council.open_round` の `deadline` が指定されていれば採用する。相対期間は当該ラウンドの開始時刻を起点とする。
  2. R0開始時に凍結した当該ラウンドの保存設定に有効な `deadline` があれば採用する。相対期間は当該ラウンドの開始時刻を起点とし、絶対時刻は保存設定の規則に従って評価する。
  3. 直前ラウンドで解決された締切が相対期間に基づく場合は、その期間を当該ラウンドの開始時刻に再アンカーして継承する。直前ラウンドの絶対締切は継承しない。
  4. いずれもなければ当該ラウンドは締切なしとし、会議タイムアウトを別途適用する。
- R2 にも上記の締切の決定順序を適用する。Fail 時の `chair_gate` の `r2_deadline` が手順1の呼び出し時指定に当たり、手順3の直前ラウンドはR1とする。
- ラウンド別の `quorum` は任意で、未指定のラウンドにはトップレベルの `quorum` を既定値として適用する。`quorum` は受領集計で達成と判定するために必要な必須席の受領数を表す。`create_meeting` / `council.update_setup` のどちらでも、設定するクォーラムの値はトップレベルとラウンド別のいずれも1以上かつ席数以下の整数とする。設定方法は §1.3 に従う。
- 席は既定で必須席とする。`SeatConfig` に `optional: true` を指定した席だけが任意席となり、バリア成立を妨げない。`quorum` は `received` の必須席の数と比較する。任意席の回答もバリアで `received` として凍結されれば配布するが、クォーラム判定には数えない（§4.2・§6）。
- **提出経路の適格性**。`submit_answer` と `transcribe_web_seat` の呼び出し主体の権限は、対象席の接続種別を問わずに判定する。段階 (4) で接続種別の適格性を判定し、Web 席への `submit_answer` と非 Web 席への `transcribe_web_seat` を `invalid_state` で拒否する。`detail` には両操作の標準キー `{ reception_state, round_frozen, deadline_eligible }` を含め、`deadline_eligible` は以下の通常の規則で算出する。
- **締切適格性**。ラウンド締切がある場合、本答・批評の初回提出・初回転記は、当該操作の受信時刻を単調時計上の締切と比較し、締切以前（同時を含む）なら処理が締切後でも締切適格性があるとする。現行版または無効化版の差し替えは、接続種別を問わず初版の締切適格性を継承する。ラウンドと対象席の状態は引き続き全体順序で当該操作を処理する位置で検査する。対象席の接続種別が当該操作に不適格な場合も、同じ規則で `deadline_eligible` を算出する。席が `absent` / `waived` に確定した後、およびラウンド凍結後は、当該席の本答・批評の提出をコアが拒否する。
- **状態変更操作の取り込み順**。コアはパケット提出（`submit_answer`、`transcribe_web_seat`、`submit_attest` を含む）、`waive_seat`、`declare_absent`、議長操作を含むすべての状態変更操作をコア受信順に処理する。ラウンド締切時刻と会議タイムアウト判定時刻は、それぞれのスイープを全体順序に置くために使う。ラウンド締切時刻または会議タイムアウト判定時刻を T とする。時刻 T のスイープは、受信時刻が T 以下のすべての操作の後、受信時刻が T より大きいすべての操作の前に置く。この全体順序上の位置はタイマー項目の登録時期に依存しない。受信時刻が T より大きい操作は常に対象スイープ後の状態で判定する。コアは単調時計の読み値が厳密に T を超えたことを確認してから時刻 T のタイマー項目を登録する。受信時刻が T より大きい操作は、タイマー項目の登録前に受信した場合も、対象スイープの処理を待つ。各項目は、全体順序で自分より前に位置するすべての項目が処理済みのときにだけ実行可能となる。先行項目には、同じ時刻に予定され種別優先順位が高いスイープや、タイマー項目が未登録でも予定済みのスイープを含む。スイープ自体のタイマー項目も登録済みでなければならない。この条件は外部操作の有無に依存しない。同時刻の項目は、(i) その時刻以前に受信した未処理の操作、(ii) ラウンド締切スイープ（同種同士は生成順）、(iii) 会議タイムアウト評価、の種別順を主キーとする（§1.5）。新設のラウンド締切スイープは、同時刻に投入済みの同種の項目すべての後、投入済みの同時刻の会議タイムアウト評価より先に置く。操作の受理可否は、全体順序の中でその操作を処理する位置における状態で判定する。受信時刻がちょうど T の初回提出・再転記は、時刻 T の対象スイープより常に前に順序づけられ、他の受理要件を満たせば受理する。ラウンド締切のスイープは先に取り込んだ締切内の提出を後から無効化しない。ラウンド締切時刻以前（同時を含む）に受信した免除は受理条件（§4.1a）を満たせば有効となり、席は `waived` になってラウンド締切のスイープの対象外となる。そのスイープで `absent` になった席への免除をラウンド締切時刻より後に受信した場合は、対象席が `absent` のため拒否する。会議タイムアウトのスイープはフラグ設定と通知のみを行い、提出の受理可否には影響しない（§1.5）。
- **attest 不一致後の再転記**。拒否理由では、全体順序上の処理位置における席の受領状態（`absent` または `waived` など）とラウンドの凍結有無を示し、初版から継承した締切適格性とは分けて説明する。締切と同時に受信した attest がスイープ前に不一致と確定し、スイープの処理位置で席が `pending` なら、スイープは席を `absent` にする。スイープでバリアが成立した場合はラウンドも凍結する（§4.3）。
- **バリア凍結後の締切スイープ**。ラウンド締切のスイープは、全体順序上の自らの処理位置でまだ `OPEN` の対象ラウンドにだけ作用する。バリア凍結の時点で当該ラウンドの締切スイープは無効となり、後から処理位置に達しても何もしない。凍結した受領表は最終とする。
- **締切スイープ内の処理順**。コアは対象ラウンドの未確定席すべてにスイープによる更新を適用してから、バリア成立を評価し、条件を満たせば凍結する。任意席の欠席記録と通知も同じスイープで確定し、そのスイープでバリアが成立する場合は凍結スナップショットに含める。
- **締切スイープでの受領**。コアは、受信時刻が締切以前（同時を含む）の操作をすべて処理した後、全体順序上のスイープの処理位置で `pending` の席を `absent` に遷移させる。当該ラウンドに attest 不一致で無効化された版があれば `reason.code: "attest_mismatch"` を記録し、`reason.code: "deadline_no_submission"` は当該ラウンドに提出が一切ない席に限って使う。欠席理由の判定でいう提出は本答・批評（Web 席の転記を含む）に限り、速報とメモは含まない。速報だけを出した席が締切スイープで `absent` になる場合は `deadline_no_submission` を記録する。非 Web 席の締切内の本答は、差し替え版を含め、提出操作の処理時点で `received` となる。締切内に転記され、`transcribed_pending_attest` の席は、提出が締切内に届いているためスイープで `absent` にせず、attest の確定、議長の免除、または議長の欠席宣言を待つ。その席が必須席なら、`received` / `waived` / `absent` に確定するまでバリアは成立しない。attest が `confirmed` なら席は `received` となり、スイープ後に `mismatch` が確定すれば、確定時に attest 不一致を理由に `absent` となる（§4.3）。ラウンドが凍結されておらず、対象席が `transcribed_pending_attest` の間は、締切後に完了した attest も §4.3 の受理条件を満たせば有効とする。
- コアは席が `absent` に遷移した時点で、欠席通知 `{ round, seat_id, kind: "absent", reason }` を生成する。`reason` には遷移時に記録した欠席理由のコード（受領表の `reason.code`）を入れる。通知は当該席への次回の `get_packets` 応答で一度だけ配達する（§4.2）。即時のpush通知は要求しない。
- **バリア成立条件**。コアはラウンドを開く操作自体の中で、受領表の全席の行を初期化した後にバリアの初回評価を行う（§4）。必須席がゼロである場合を含め、開始時点で条件を満たす場合は、その操作の中でラウンドを凍結する。`open_round` はこの場合、`round_state.phase: "frozen"` を返す。会議は R0・R1 の凍結後にそれぞれ `GATE(R0)`・`GATE(R1)` へ進んで議長操作を待ち、R2 の凍結後は `SYNTHESIZING` へ進む（§1.2）。全必須席が終端の受領状態（`received` / `absent` / `waived`）に達した時点で、締切の有無・到来やクォーラムの充足を問わずバリアを凍結する。コアは凍結時に `quorum_met` を計算し、受領集計に記録する。締切スイープは席を終端状態にする一手段である。締切がなく必須席が未確定のままなら、バリアは成立せず会議は待機する。議長は免除（`waive_seat`）または欠席宣言（`declare_absent`）で未確定の席を終端状態にできる。 `quorum_met` が `false` の場合は、統合の `reception_summary` に未達を明記する（§6）。

### 4.1a waived の理由記録

`waive_seat` の `invalid_state` では、`detail` に `reception_state` と `round_frozen` を含める（§4.3）。

コアは、対象ラウンドが現在の `OPEN` ラウンドで、対象席が `pending` または `transcribed_pending_attest` の場合にだけ `waive_seat` を受理する。受領済み（`received`）の席や、凍結済みラウンドの席への呼び出しは拒否する。免除は当該ラウンドに限り有効とする。

`waived` を宣言する際は、受領表の `reason` に `{ code, text }` を格納する。`code` は `reason_code` で指定した以下の定型コード、`text` は任意の `reason_note` とし、省略可能な場合に省略されたときは `null` とする。

| コード | 意味 |
|---|---|
| `seat_unavailable` | 席（AI/人間）が技術的・運用的理由で応答不能 |
| `quota_exceeded` | §9のクォータ上限に達し、追加依頼を見送った |
| `duplicate_coverage` | 他席の回答で論点が十分カバーされ、追加回答が不要と判断した |
| `chair_judgment` | 上記に当たらない、議長の裁量による免除 |
| `other` | その他（自由文で理由を必須記載） |

統合時に `waived` の件数として集計され（§6）、個別の理由コード・自由文は受領表に加え、パケット（gate_decisionまたはwaive操作ログ）に保持される。

### 4.2 差分配布

あるラウンドの途中で遅れて参加した席、または再配布が必要な席に対しては、全文の再送ではなく差分を送る。

著者以外の席への `answer` / `critique` の配布対象は、当該ラウンドの凍結スナップショットに含まれる `received` の現行版に限る。旧版（`superseded`）と未検証の現行版は他席への配布対象から除外する（§4.2a）。

コアは会議内で生成順に連番 `seq`（1始まりの整数）を付け、取得時の返却順序に使う。同一の `packet_sha` を持つパケットも `packet_id` ごとに配布・ack する。席入力ビューでは、会議・配布先ごとに配布済みと ack 済みの `packet_id` を記録する。席への配布と ack の単位は席とし、コアは席ごとに配布世代 `delivery_epoch` を管理する。その席について認可された席本人またはドライバのいずれかに席入力ビューで返却した時点で、その席に配布済みとする。その席について認可された主体のいずれからでも ack できる。

配布世代 `delivery_epoch` は会議と `seat_id` の組ごとに会議の存続中は単調に増加し、値を再利用しない。未使用の `seat_id` の初期値は 1 とする。（§1.3）

`council.update_setup` で席の `principal` または `driver_principals` の集合が変わった場合、その席の配布世代 `delivery_epoch` を増やし、配布済み・ack 済みの記録を消去し、全パケットを未配布に戻す。旧主体による ack は無効となり、更新後に認可された主体に現行設定と取得時の認可範囲に従って再配布する。（§1.3）

`council.get_packets` は任意引数 `view: "input" | "oversight"` を受け付ける。既定値は `"input"` とし、差分配布と `ack_packet_ids`・`delivery_epoch` による ack は席入力ビューでのみ有効とする。席入力ビューには認証済み principal にひも付く席が必要である（§3.2）。

席入力ビューでは、コアは空でない `ack_packet_ids` を指定したときに限り、`delivery_epoch` の省略を理由に呼び出し全体を契約エラー（`invalid_argument`）として拒否する。ack を送らない通常の取得では `delivery_epoch` を省略できる。`view: "oversight"` に `ack_packet_ids` と `delivery_epoch` のいずれかを渡した場合も、コアは呼び出し全体を `invalid_argument` として拒否する。未知の `packet_id` の ack または現行世代と一致しない ack の無視と監査ログへの記録は、契約と認可の条件を満たす席入力ビューの呼び出しでのみ適用する。

両ビューで、`round` 指定時はそのラウンドの認可済みパケットを返し、省略時は認可範囲の全ラウンド分に認可済みの会議レベルのパケットを加えて返す。

席入力ビューでは、この範囲内の未 ack のパケットを `seq` 順に `new_packets` として返す。席入力ビューの配布応答には、同じ整合スナップショットの当該席の現行 `delivery_epoch` を含める。呼び出し主体は配布応答の `delivery_epoch` を `ack_packet_ids` とともに渡す。コアは現行世代の値を伴う ack のみを受理対象とする。`delivery_epoch` が当該席の現行世代と異なる場合は、古い世代でも未来の世代でも ack 部分だけを無視し、監査ログに記録して、パケット取得を続ける。現行世代の値を伴う場合、`ack_packet_ids` で指定したうち、その配布先に席入力ビューで配布済みであり、かつ現時点の認可範囲内にあるパケットだけを ack 済み集合に追加する。未知・認可外・未返却の `packet_id` はエラーにせず無視し、冪等な再試行を許す。未 ack のパケットは次回も認可範囲と `round` の条件を満たせば再返却する。R1開始時のR0受領分にも同じ方式を適用し、開始時に自動で配布済みにはしない。差し替え情報 `superseded` も同じ範囲でフィルタし、旧版と新版の両方が範囲内のものだけを返す。新版ヘッダの `supersedes` で見える旧版の `packet_id` 自体は、旧版の内容を開示しない。その `packet_id` を ack しても、旧版パケットがその配布先に未配布なら無視する。

席入力ビューの応答の封筒には、パケットとは別に席単位の `notices` 配列を含める。コアは当該席の欠席通知（§4.1）を、`round` の指定や配布対象パケットの有無にかかわらず、その席の有効な席入力ビューの次回の `get_packets` 呼び出しで返す。配達済みの記録はパケットと同じ `delivery_epoch` の仕組みに従って席単位で管理し、コアは受信順序の中で通知の選択と配達済みの記録を原子的に行う。受信順序で先に処理された `get_packets` が通知の配達を確定し、後続の呼び出しでは同じ通知が配達済みとして見える。応答の送信に失敗しても通知は再配達しない。欠席の事実は受領集計と監督ビュー（`oversight`）で確認できる。配達対象の通知がなければ空配列を返す。

```json
{
  "status": "ok",
  "new_packets": ["<packet>", "..."],
  "superseded": [{"old_packet_id": "string", "new_packet_id": "string"}],
  "notices": [{"round": "R0", "seat_id": "seat_a", "kind": "absent", "reason": "chair_declared"}],
  "delivery_epoch": 1,
  "setup_version": 1
}
```

### 4.2a get_packets の認可

`"chair"` と `"human"` は予約済みの呼び出し主体識別子とする。コアは、席の `seat_id` にいずれかの値を指定した `council.create_meeting` / `council.update_setup` を `invalid_argument` で拒否する。

呼び出し側の席やロールを名乗る引数には、席として呼ぶ場合は自席または代理する席の `seat_id`、議長として呼ぶ場合は予約値 `"chair"`、人間として呼ぶ場合は予約値 `"human"` を渡す。召集者として読む場合は `view: "oversight"` と `caller_seat_id: "convener"` を指定する。コアはこの組み合わせで `"convener"` をロール指定として解釈し、認証済み principal が当該会議の召集者と一致することを確認する。`input` で `"convener"` が指定された場合は、通常の席 ID として照合する。`get_packets` の `caller_seat_id` は必須とし、指定値を接続トークンまたはセッションにひも付く認証済み principal の会議内の席またはロールと照合する。席を指定した場合、呼び出し主体の認証済み principal が当該席の `principal` と一致するか、当該席の `driver_principals` に含まれる場合に限り照合を通す。不一致はエラーとする。`input`（`view` 省略時を含む）では、呼び出し主体の認証済み principal に本人または認可ドライバとしてひも付く、当該会議に実在する席の `seat_id` を `caller_seat_id` に指定しなければならない。コアは `input` で予約値 `"chair"` / `"human"` を拒否する。これらの予約値は、それぞれの認可条件に従い、`oversight` および議長ロール操作でのみ有効とする。認可ドライバは担当席と同じ権限で席入力を取得し、担当席の配布先として ack できる。認可ドライバが監督ビューを使えるのは、その principal が独立に当該会議の召集者・議長・人間参加者のいずれかのロールを持ち、そのロールで監督ビューの認可条件を満たす場合に限る。ラウンドに属するパケットのビューごとの認可は（principal, そのラウンドでの役割）で評価する。

`get_packets` の返却形式と認可は `view` で指定する。`council.get_packets` はビューにかかわらず `setup_version` を返す。`council.get_packets` と `council.get_state` では、各応答は会議状態の単一の整合スナップショットから計算する。応答の `setup_version` はそのスナップショットの設定版であり、パケット選択と `packet_state` も同じスナップショットに基づく。旧いパケット集合と新しい `setup_version` が一つの応答に混在することはない。

表面は `council.get_state` と `council.get_packets` のいずれについても、資料とその応答の `setup_version` を一体で保持し、資料を再表示するまで確認に使う版を更新してはならない。`council.confirm_share` には、表示した資料を含む応答の `setup_version` を渡す。会議参加主体は、会議作成直後から `agenda`（`round: null`）を、ゲート判定の確定後に `gate_decision`（`round: "R1"`）を、生成後に `synthesis`（`round: null`）を取得できる。`note`（`round: null`）は投稿後、配布保留と監督ビューの認可の範囲内で取得できる。`note` の席への配布には速報と同じ §5 の保留規則を適用する。

`council.get_state` は §8.1 の開示範囲に従った各席の文脈契約と同じ整合スナップショットの `setup_version` を一体で返す。確認の対象は現行設定の資料に限る。差し替えられた旧 `agenda` の内容に基づく共有確認はできない。

attest の文脈で「版」とは、回答・批評の提出版（転記版を含む）、すなわち受領・版連鎖に参加するパケットを指す（§4.3）。

- **席入力としての配布（`view: "input"`、既定）**。`new_packets` の各要素は応答上のパケットオブジェクトとする（attest のメタデータは §3.1）。席入力ビューで配布する `agenda` は現行版に限る。他席の `answer` / `critique` は、対象ラウンドの凍結スナップショットに含まれる `received` の現行版のみを返す。バリア成立前に取得できるのは、自席のパケット、§5 により配布保留されていない `flash` / `note`、`agenda`、および取得可能になった `gate_decision` / `synthesis`、および役割に応じて認可されるその他のシステム系パケットに限る。他席のR0回答はR1開始以降に認可対象とし、未 ack の席に返す。自席のR0回答は当初から認可対象とする（§4.2）。attest は対象転記版の配布に従い、その版を受け取る資格のある席に限って配布する。対象席は常に attest の配布対象に含める。
- **召集者・議長・人間参加者の監督ビュー（`view: "oversight"`）**。ラウンドに属するパケットの監督ビューでの取得は、当該会議の召集者 principal・議長 principal・人間参加者に認可する。バリア成立前は対象ラウンドの参加席を兼ねない principal に限り、成立後は参加席を兼ねる principal にも認可する。対象ラウンドの参加席の兼務は、その席の `principal` または `driver_principals` と呼び出し主体の認証済み principal を照合して判定する。`ChairConfig.seat_id` の指定の有無にかかわらず判定し、他席の現行ラウンド回答に対するバリア前の監督ビューの閲覧制限は、本人として保持する席および代理できる席ごとに適用する。明示した `round` について監督ビューの認可がない場合はエラーとする。`round` を省略した場合は認可されていないラウンドを応答から除外する。保留中の `note` と差し替え済みの `agenda` を除き、会議レベルのパケットの監督ビューでの取得認可は、会議参加主体であれば足りる（認可ドライバには上記の独立ロールの条件を適用する）。監督ビューでは、取得を認可されたラウンドのすべての attest を、対象転記版の状態にかかわらず返す。召集者は、自分が召集した会議で対象転記版の配布資格にかかわらず常に attest の配布対象となり、監督ビューで取得する。取得には通常のラウンド認可を適用する。監督ビューで得た内容は席入力として使わない。

コアは保留中の `note` に投稿時ラウンド（発生ラウンド）をひも付ける。そのバリアが成立するまでは、監督ビューでも発生ラウンドのバリア前回答と同じ取得制限を適用し、会議内で席ロールを持つ主体（席本人または認可ドライバとして席を兼務する召集者・議長・人間参加者）には返さない。バリア成立後は通常の会議レベルのパケット（`round: null`）として全参加主体に取得を認可する。
- 認可範囲外のパケットと差し替え情報は応答から除外する。

会議内で凍結された回答は席が会議に提出した寄稿そのものであり、会議内での配布を `sharing_policy` で制限しない。事務局・議長は、凍結済み回答に含まれない席固有資料を他席に配布するラウンドパケット（`answer` / `critique`）に混ぜてはならない。この規則は統合での引用には適用しない。統合での引用は §6 に従う。`note` の投稿者も共有規則に従い、凍結済み回答に含まれない席固有資料を `note` に混ぜてはならない。席固有資料の利用可否は席の `sharing_policy` に従う（PRODUCT.md §2.2）。

- `no_share` の資料は確認記録があっても一切利用できず、コアはその資料を対象とする `council.confirm_share` を拒否する。
- `share_with_confirmation` の資料は、資料参照、用途、宛先（必要な場合）が一致し、`setup_version` が会議の現在の値と一致する確認記録がある場合に限り引用・共有できる。
- `share_freely` の資料は確認記録なしで引用・共有できる。

`confirm_share` の対象は席固有資料（`seat:<seat_id>:<item_id>`）に限る。`packet:<packet_id>` が渡された場合は、対象の種別の不一致として段階 (0) で `invalid_argument` を返す。パケットの配布は配布規則（配信集合）に従い、統合での引用は回答の引用規則に従う（§4.2・§4.2a・§6）。

`council.confirm_share` は当該会議の参加者である人間 principal（§8.1 の人間参加者の定義に従う）のみが呼び出せる。会議の参加者でない人間からの呼び出しはコアが拒否する。`meeting_id`、対象資料の `material_ref`、`purpose`、用途に応じた宛先を受け取る。用途別に許容する宛先フィールドは、席間共有（`share_with_seat`）では必須の `to_seat_id` のみとし、`cite_in_synthesis` と `share_external` ではいずれもなしとする。用途に適用できない宛先フィールド（`destination` を含む）が渡された場合、コアは黙って無視せず、段階 (0) で `invalid_argument` を返す。表示した資料を含む応答の整数の `setup_version` を必須引数とする。コアは資料・宛先席の参照を解決する前に `setup_version` を会議の現在値と照合する。版が一致しない場合は、資料が現行設定に存在するかどうかにかかわらず、コアは `invalid_state` を返し、`detail` は `{ meeting_state, expected_setup_version, provided_setup_version }` とする。 `expected_setup_version` には処理位置での現在の版、`provided_setup_version` には引数で指定された版を入れる。版が一致した場合にだけ資料参照を現行設定に対して解決し、参照先が現行設定に存在しなければ `not_found` を返す。用途が `share_with_seat` の場合に、指定された宛先席（`to_seat_id`）が現行設定に存在しない場合は、設定版の一致と資料参照の解決の後に、段階 (3) で `not_found` を返す。段階 (4) で共有ポリシーを判定し、`no_share` の場合は `invalid_state` を返す。`share_with_seat` ポリシーでは、用途が `cite_in_synthesis` または `share_external` の場合、および用途が `share_with_seat` で現行設定に存在する `to_seat_id` が `seat_ids` に含まれない場合も、`invalid_state` を返す。`detail` は `{ meeting_state, sharing_policy }` とする。`cite_in_synthesis` の確認が許可する範囲は、対象資料を `synthesis` に含めることと、その `synthesis` を会議の全参加主体に配布することまでとする。これは席固有資料の会議内開示の正規の経路である。（§6）確認を会議内で（資料参照、用途、宛先、`setup_version`）の組として記録する（§8.1）。`share_external` は、人間がコアの外で資料を手作業で共有する際、確認が必要な場合に事前に作る確認記録である。v1 のコアは公開ミラー転送や外部出力などの会議外共有を実行する操作を持たない（§8）。

`sharing_policy` の値は `"no_share"`、`"share_with_confirmation"`、`"share_freely"`、または `{ kind: "share_with_seat", seat_ids: string[] }` とする。指名する宛先席の集合は、このオブジェクトの `seat_ids` に格納する。`share_with_seat` ポリシーが許可する用途は、その集合に含まれる席への席間共有に限る。

v1 のコアは席固有資料を他席へ個別に届ける操作を持たない。`share_with_seat` は `share_external` と同様に、人間がコアの外の経路で対象席へ資料を渡す前に作る確認記録である。将来、席間へ資料を届ける操作を追加する場合、コアは実行前に資料参照、用途、宛先、現在の `setup_version` が一致する確認記録を照合し、一致する記録がなければ操作を拒否しなければならない。

照合では、資料参照、用途、宛先（必要な場合）が一致し、`setup_version` が会議の現在の値と一致する確認記録だけが有効である。`council.update_setup` の成功で設定版が進むと旧版の確認記録は失効する。確認が必要な資料は最終設定に対して確認を取り直す。

`material_ref` は名前空間つき文字列とする。パケット由来の資料は `packet:<packet_id>`、文脈契約由来の席固有資料は `seat:<seat_id>:<item_id>` とする。`item_id` は当該席の `seat_specific_materials` の項目の文字列 `id` である。`seat_id` と席固有資料の項目の `id` は `[A-Za-z0-9_-]+` に制限する。この制限により、上記の名前空間形式は `:` で一意に分解できる。コアは `create_meeting` / `update_setup` での登録時に、`:` を含むなどこの制限に違反する ID や、同じ席の `seat_specific_materials` 内で重複する `id` があれば登録を拒否する。`"chair"` と `"human"` は予約語とし、コアは `create_meeting` / `update_setup` でこれらを `seat_id` として登録する要求を拒否する。（PRODUCT.md §2.2）

兼務議長は認可に応じて呼び出しごとにビューを選べる。監督ビューは閲覧用であり、ack を使わず、配布済み集合を持たない。上記のラウンド条件と現時点の認可範囲に該当する全件（現行版・旧版・未検証版を含む）を毎回 `seq` 順に返す。会議レベルのパケットを取得する場合も、差し替え済みの `agenda` を返すのは、`oversight` の認可を持つ当該会議の召集者・議長・人間参加者が監督ビューで取得する場合に限る。`oversight` の認可を持たない席には、会議レベル取得でも現行の `agenda` のみを返す。監督ビューでは認可された `agenda` の全版を `packet_state` つきで返す。検証状態が変われば、次回の取得で新しい状態が見える。

監督ビューでは `new_packets` の各要素を `{ packet, packet_state, missing_records, declared_missing_records }` とし、`packet` に応答上のパケットオブジェクト（attest のメタデータは §3.1）、`packet_state` に取得時点の状態を格納する。`missing_records` は、凍結済み受領版についてコアが検出した構造化提出の欠落を格納する文字列の配列（`string[]`）とする。対象が凍結済み受領版でない場合や、該当する欠落がない場合は空配列を返す。同じパケット版について、統合で受理された議長の欠落申告を `declared_missing_records`（`{ seat_id, packet_id, note }` の配列）として、コア検出の `missing_records` と並べて返す。出所はフィールドで区別し、申告がなければ空配列を返す。`packet_state` はパケット（版）の状態を表す。`version` は全 kind 共通で差し替えを反映する。席の状態である `absent` / `waived` は `packet_state` に現れず、`get_state` の受領表で確認する。attest 不一致で版を無効化した時点では、受領表の `current_packet_id` は `null` となり、`invalidated_packet_id` にその版の ID を保持する。現行版がない状態からの再転記では、この ID を `supersedes` に指定する。無効化版の `packet_state.version` は差し替えまで `current` とする（§4）。`verification` が `verified` / `unverified` になるのは Web 席の `answer` / `critique` のみで、その他は `not_applicable` とする。

```text
{
  "version": "current" | "superseded",
  "verification": "verified" | "unverified" | "not_applicable",
  "reception": "received" | "transcribed_pending_attest" | "invalidated" | "superseded" | "not_applicable"
}
```

| パケット（版） | `version` | `verification` | `reception` |
|---|---|---|---|
| 非 Web 席の `answer` / `critique` の現行版 | `current` | `not_applicable` | `received` |
| Web 席の `answer` / `critique` の現行版（attest 確認済み） | `current` | `verified` | `received` |
| Web 席の `answer` / `critique` の現行版（attest 未確定） | `current` | `unverified` | `transcribed_pending_attest` |
| Web 席の `answer` / `critique` の無効化版（attest 不一致） | 差し替え前は `current`、差し替え後は `superseded` | `unverified` | `invalidated` |
| 無効化されていない `answer` / `critique` の旧版 | `superseded` | 差し替え当時の値を保持 | `superseded` |
| その他（`agenda` / `flash` / `gate_decision` / `synthesis` / `attest` 等） | 現行版は `current`、差し替えられた版は `superseded` | `not_applicable` | `not_applicable` |

凍結後の監督ビューで attest 未確定を `packet_state.reception: transcribed_pending_attest` として返すのは、有効な現行転記版に限る。attest 未確定のまま差し替えられた旧版は `packet_state.reception: superseded` として返す（§4.3）。

### 4.3 Web 席の attest（転記内容の確認）

本節の状態段階の規定（attest と再転記の状態判定を含む）は、各操作が先行する段階の検査を通過して段階 (4) に到達した場合にのみ適用する。

段階 (4) で接続種別の適格性を判定し、Web 席への `submit_answer` と非 Web 席への `transcribe_web_seat` を `invalid_state` で拒否する。提出経路の適格性は §4.1 に従う。`detail` には `{ reception_state, round_frozen, deadline_eligible }` を含める。接続種別による拒否でも締切適格性の算出方法は変わらず、§4.1 に従って算出した `deadline_eligible` を `detail` に含める。たとえば、Web 席本人が、attest 不一致で現行版がない当該ラウンド・席の `invalidated_packet_id` と一致する `supersedes` を指定して `submit_answer` を呼ぶ場合、段階 (2) の版照合を通過し、段階 (4) で接続種別の不適合により `invalid_state` となる。`detail.deadline_eligible` は §4.1 の継承規則に従い、初版の締切適格性を継承する。監査上の拒否分類は拒否した段階に従う。ラウンドの凍結と `supersedes` の照合エラーが重なれば、段階 (2) が先行し、`invalid_argument` を返して引数拒否として記録する。段階 (4) で拒否した場合は状態拒否として記録し、凍結が該当すればその事実も記録する。

Web 席は「手渡し」（人間がWeb UIの出力をコピーして事務局に転記）を正式な接続方式とする。転記は**原則「未検証」**であり、v1 では `verbatim_confirm` の attest が確定するまで `received` には遷移しない。受領表の状態は `transcribed_pending_attest` とし、保存値と API の返却値にもこの値を使う。バリアとクォーラムの判定に限り、`pending` と同様に終端状態に達していない席として扱い、受領数に数えない。表面での描画は §7 に従う。締切内の転記は、ラウンド締切後も `transcribed_pending_attest` のまま attest の解決、議長の免除、または議長の欠席宣言を待つ。この間は、締切後に完了した attest も §4・§4.1 に従って受け付ける。

共通エラー形式は `{ code, detail? }` とする。`invalid_state` では `detail` が必須であり、全体順序上の処理位置での判定に使った事実を機械可読なオブジェクトとして含め、同じ事実を監査ログにも記録する。`invalid_state` 以外では `detail` は任意とする。

状態段階では該当する判定事実をすべて `detail` に含める。クォータ超過時は操作の標準キーに加えて `quota_exceeded: true` を含める。凍結とクォータ超過が重なれば、`round_frozen: true` と `quota_exceeded: true` の両方を返す。

| 操作 | `invalid_state` の `detail` に含めるキー |
|---|---|
| `submit_answer` / `transcribe_web_seat` | `{ reception_state, round_frozen, deadline_eligible }` |
| `submit_flash` | `{ reception_state, round_frozen }` |
| `submit_attest` | `{ target_reception_state, round_frozen }` |
| `confirm_share`（設定版不一致） | `{ meeting_state, expected_setup_version, provided_setup_version }` |
| `confirm_share`（`no_share`、または `share_with_seat` ポリシーで許可されない用途・宛先） | `{ meeting_state, sharing_policy }` |
| `waive_seat` / `declare_absent` | `{ reception_state, round_frozen }` |
| `synthesize`（資料・パケットの引用拒否） | `{ meeting_state, offending_materials }` |
| `update_setup` / `chair_gate` / `open_round` / `synthesize` など、会議状態で判定する操作 | `{ meeting_state }`（必要に応じて `round` を追加） |
| その他 | 最低限 `{ meeting_state }` |

`reception_state` は処理位置での対象席の受領状態とする。`target_reception_state` は、対象が attest の文脈での版（§4.2a）の場合は処理位置でのその席の受領状態、版でない対象（`flash`、`note`、`agenda` 等）の場合は `null` とする。`round_frozen` はその位置で対象ラウンドが凍結済みかを示す真偽値とする。対象ラウンドが未開始の場合、受領状態は `null`、`round_frozen` は `false` とする。

`deadline_eligible` は初回提出・初回転記では当該操作の受信時刻で判定する。差し替えでは接続種別を問わず初版から継承した締切適格性を示す（§4.1）。対象ラウンドが未開始の場合は `null`、開始済みで締切がなければ `true` とする。`submit_attest` と `submit_flash` に締切適格性の概念はない。`submit_flash` を議長ロールで呼び出した場合は `reception_state` を `null` とする。

#### 共通検査順

検査は全体順序上の当該操作の処理位置で行う。以下の段階と分岐に従い、最初に該当するエラーを返す。

0. **形式検査**。状態を参照せず、型・必須項目・書式（タイムゾーン指定を含む）と、検索を要しない許容値・引数間の一致を検査する。違反は `invalid_argument` とする。 `create_meeting` の `seat_ids` がリクエスト内の席を指すことの検査もこの段階で行う。
1. **認可**。未知の会議と、呼び出し主体が参加していない実在会議には、区別できない同じ `unauthorized` を返す。対象に依存しない主体・役割の認可を対象検索より先に行い、失敗した場合は `unauthorized` を返す。
2. **検索を要する引数検証**。`supersedes` と当該ラウンド・席の現行版（attest 不一致で現行版がない場合は `invalidated_packet_id` が指す版）の照合は、接続種別を問わず `submit_answer` と `transcribe_web_seat` に共通の規則で行う。後継版の `hash_match` では、対象が attest 適格な種別（本文を持つ転記版）の場合の証拠突合もこの段階で行う。引数の契約違反は `invalid_argument` とする。対象席が存在しない場合は照合を行わず、次の段階へ進む。処理時点より厳密に過去の締切上書きの検査もこの段階で行う。 `update_setup` の `seat_ids` が更新後の設定に含まれる席を指すことの検査も、保存済みの現行設定を参照してこの段階で行う。保存済み設定を要する `update_setup` の更新後の設定の検証（接続種別の変更後のクォータ検証を含む）もこの段階で行う。
3. **参照先の存在確認**。認可済みの呼び出し主体に対し、指定された参照先が存在しない場合は `not_found` を返す。
4. **状態検査**。クォータを含む状態の前提条件を検査する。違反は `detail` 付きの `invalid_state` とする。

対象に依存しない認可は段階 (1) で行い、対象の検索に先行する。議長限定の操作では、非議長には対象席の存否にかかわらず `unauthorized` を返す。対象に依存しない認可を通過した呼び出し主体が存在しない席を指定した場合は、段階 (3) で `not_found` を返す。その席として行動する権限など、対象に依存する認可は対象の解決後に判定し、権限がなければ `unauthorized` を返す。

`R0` / `R1` / `R2` は会議の構造として開始前から存在する。未開始ラウンドでも段階 (2) の版照合を行う。このとき照合対象の版はなく、非 `null` の `supersedes` は `invalid_argument` とする。先行する段階の検査を通過した場合に限り、未開始のラウンドへの提出は段階 (4) で `invalid_state` とし、`detail` には上記の未開始時の値を用いる。この列挙に含まれない `round` の値は段階 (0) の形式検査で `invalid_argument` とする。

操作は段階 (1) の検索前認可と検索後認可の間に対象検索を挟める。検索前認可を通過し、対象が存在しなければ、その時点で段階 (3) の `not_found` を返す。対象が存在すれば検索後認可を行い、認可が完了してから段階 (2) 以降に進む。

例外として、`confirm_share` では検索分岐の一般則に優先して、すべての参照解決（資料・宛先席）に先立ち設定版を照合する。版が一致した場合にだけ参照を解決する。設定版の不一致と宛先席の不存在が重なれば、版不一致による `invalid_state` が優先する（§4.2a）。

#### submit_attest の検査順序

v1 のコアは `verbatim_confirm` のみを受理する。`method=hash_match` の `submit_attest` は、v1 の許容値の範囲外として段階 (0) で `invalid_argument` を返す。

`submit_attest` の `invalid_state` では、`detail` に `target_reception_state` と `round_frozen` を含め、各キーには本節の定義に従った値を設定する。

attest は共通検査順の検索前認可・対象検索・検索後認可の分岐を用いる。(a) を段階 (1) で行い、(b) で参照先がなければ段階 (3) の `not_found` を返す。参照先があれば (c) で認可を完了してから、段階 (4) の状態検査に進む。後継版の `hash_match` では状態検査の前に段階 (2) の証拠の引数検証を行う。

`verbatim_confirm` の `evidence` は `{ method, confirmer, target_packet_id }`、`hash_match` の `evidence` は `{ method, confirmer, target_packet_id, source_hash }` とする。両方式で `method` は方式名、`confirmer` は空でない文字列、`target_packet_id` は文字列とし、いずれも必須とする。`hash_match` の `source_hash` は必須で、64文字の小文字16進数とする。 引数の `method` と `evidence.method` は一致を必須とする。不一致は手順0で `invalid_argument` とし、一致した `method` のスキーマで `evidence` を検証する。

- 手順0（形式検査）。`evidence` の入れ子項目を含むすべての引数の型・必須項目・許容値・書式を検査し、`verbatim_confirm` への `source_hash` の指定、定義外の追加フィールド、必須文字列への `null` を含め、違反があれば `invalid_argument` を返す。`evidence.target_packet_id` が引数の `target_packet_id` と異なる場合も、引数間の整合に関する形式違反としてここで `invalid_argument` を返す。
- 手順 (a)（検索前認可）。認証済みの呼び出し主体が当該会議の召集者、または当該会議のいずれかの Web 席の `principal`・認可ドライバであることを確認する。この条件を満たさない場合、または `evidence.confirmer` が認証済みの呼び出し主体の識別子と異なる場合は、対象パケットを検索する前に `unauthorized` を返す。
- 手順 (b)（検索）。当該会議で `target_packet_id` に指定されたパケットを検索し、未知なら `not_found` を返す。
- 手順 (c)（対象席認可）。対象パケットが当該会議の Web 席にひも付かない場合（席なし種別など）は、認可対象の席が存在しないため `unauthorized` を返す。呼び出し主体が当該会議の召集者、対象 Web 席の `principal`、または対象 Web 席の `driver_principals` に含まれる認可ドライバのいずれにも該当しなければ `unauthorized` を返す（§8.1）。
- 手順 (d)（状態検査）。先行する段階の検査を通過した呼び出しに対し、対象がその席のattest 未確定の現行転記版でない場合（`flash`、差し替え済みの版、判定確定済みの版、席が `transcribed_pending_attest` でない場合など）や、ラウンドが凍結済みの場合は `invalid_state` を返す。ラウンドが凍結されておらず、対象がその席の有効な現行転記版で、判定が未確定かつ席の受領状態が `transcribed_pending_attest` の場合に限り、判定の確定に進む。

#### body_sha の定義

attestの照合基盤として `body_sha` を定義する：**保存された本文（packetの `body.body` 文字列）のUTF-8バイト列に対するSHA-256**（16進小文字64文字）。改行文字（`\r\n` / `\n` 等）の正規化は行わない（保存されたバイト列をそのままハッシュする）。

テストベクタ：本文文字列 `"Hello"` の body_sha は

```
body_sha = 185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969
```

#### hash_match（後継版の判定規則）

1. §8.1 で認可された呼び出し主体が、転記元（Web UIの原文）側で別途取得したハッシュ値を `evidence.source_hash` として `submit_attest` に提出する。
2. 段階 (2) では、対象が attest 適格な種別（本文を持つ転記版）の場合に限り、コアは保存済みパケット本文から計算した `body_sha` と `evidence.source_hash` を照合する。一致すれば `confirmed`、不一致なら `mismatch` とする。この一致・不一致は attest の判定結果であり、状態検査を通過した場合に確定する。不適格な種別では段階 (2) の証拠突合を行わず、認可を通過した対象は段階 (4)（手順 (d)）で `invalid_state` として拒否する。
3. コア側の照合結果を確定結果とし、呼び出し元の `result` は参考情報として記録する。

#### verbatim_confirm

1. `verbatim_confirm` の `submit_attest` を呼び出せるのは、当該会議の召集者 principal（運用者）、対象 Web 席の認証済み principal（席本人）、またはその席の認可ドライバ に限る（§8.1）。確認者による確認結果の申告そのものを証拠とする。確認結果を `result` として提出する。
   ```json
   { "method": "verbatim_confirm", "confirmer": "string (認証済み principal の識別子)", "target_packet_id": "string" }
   ```
2. 手続きが適正であれば、コアは認可された確認者の申告 `result`（`confirmed` / `mismatch`）そのものを確定結果とする。未認証、権限外、または手続きに不備のある申告では結果は確定しない。コアはその提出をエラーとして拒否し、attest パケットを作らず、拒否を会議の操作ログに記録する。拒否は `mismatch` の確定とは区別する。

#### 申告と確定の保存

コアは受理した提出を §3.1 のヘッダ割当に従って attest パケットとして記録し、§3.2 の方式別の入力オブジェクトをそのまま本文として保存する。方式を問わず、対象転記版の `packet_id` にひも付くコア側の確定記録に、attest パケットの ID、保存済み転記本文から計算した `body_sha`、確定結果（`confirmed` / `mismatch`）、確定した全体順序上の位置を保持する。申告は attest パケット本文から復元でき、確定結果はコア側の確定記録から復元できる。監督ビューでは、対象パケットの `packet_state.verification` に確定結果に対応する検証状態（`confirmed` は `verified`、`mismatch` は `unverified`）を提示し、不一致は `packet_state.reception` の `invalidated` でも確認できる（§4.2a）。API 応答の `verified_result` にはコアの確定結果を返す。

#### 版・集計・未検証の扱い

- attest パケットは対象転記版のラウンドの取得範囲に含める。席入力ビューでは、対象転記版を受け取る資格のある席に配布し、対象席は常に配布対象に含める。召集者は、自分が召集した会議で対象転記版の配布資格にかかわらず常に attest の配布対象となり、監督ビューで取得する。取得には通常のラウンド認可を適用する。監督ビューは、取得を認可されたラウンドのすべての attest を返す（§4.2a）。パケット自体はラウンドの回答集合に含めず、バリア・クォーラム（定足数）の判定に影響しない。
- 方式を問わず、段階 (4) に到達した `submit_attest` をコアが受理するのは、対象席の当該ラウンドの受領状態が `transcribed_pending_attest` の間に限る。対象席が `absent` / `waived` / `received` に確定している場合は、締切の有無や時刻を問わず拒否する。拒否時は attest パケットを作らず、会議の操作ログに記録する。
- バリア凍結で当該ラウンドは閉じる。コアは以後そのラウンドへの `submit_attest` が段階 (4) に到達した場合に、「凍結後」として拒否し、attest パケットを作らず、拒否を会議の操作ログに記録する（§4）。v1 で凍結済みラウンドの転記版を対象に `method=hash_match` を指定した場合は、段階 (0) の `invalid_argument` が先行し、「凍結後」としては記録しない。凍結時点で未確定の attest は、当該ラウンドでは「attest 未確定」のまま確定する。いずれの版も `packet_state.verification` は `unverified` のままとする。凍結後の監督ビューで attest 未確定を `packet_state.reception: transcribed_pending_attest` として返すのは、有効な現行転記版に限る。attest 未確定のまま差し替えられた旧版は `packet_state.reception: superseded` として返す（§4.2a・§6）。
- 受理された `waive_seat` / `declare_absent` は、現行版の検証状態にかかわらず席の受領状態をそれぞれ `waived` / `absent` にする。版の attest 状態はパケット側の記録に残る。現行版の attest 状態で席の受領状態を判定するのは、席が免除・欠席で終端となる前の `pending`（`transcribed_pending_attest` を含む）または `received` の間に限る。（§4）
- 再転記が段階 (4) に到達し、ラウンドが `OPEN`（バリア未成立）の間は、`transcribed_pending_attest` の席の現行版は初版から継承した締切適格性がある場合（§4.1）に差し替えられる。差し替え版が現行版となり、その席は `transcribed_pending_attest` として新版を attest 未確定として扱う。差し替えで会議タイムアウトはリセットされない（§4）。
- 段階 (4) に到達した attest は**判定が未確定の有効な現行版にのみ適用できる**。版に対する判定（`confirmed` / `mismatch`）は、最初に手続き適正に確定した時点で終局となる。確定済みの版への後続の attest はすべてエラーとして拒否する。差し替え済みまたは無効化済みの版への attest も拒否する。拒否時は attest パケットを作らず、会議の操作ログに記録する。
- `target_packet_id` に対する確定結果としてコアが `confirmed` をコア側の確定記録に保存するまで、該当パケットは「未検証の回答」として扱われる。未検証の回答は：
  - 統合時の `received` 件数（§6）に数えない。
  - 合意（`agreements`）の根拠に一切使わない。`waived` や `absent` で閉じた席の attest 未確定の版にも適用する。
  - 統合の `unverified_items` に未検証回答への参照を保存するときの形式と受理条件は §6 に従う。
- `confirmed` が確定した版は `received` となり、`mismatch` が確定した版は `invalidated` となる。後続の attest を拒否しても、これらの状態は変わらない。差し替え規則で許される場合は、対象版を差し替えて判定への異議を扱い、新版について attest を行う。
- 締切スイープ前（締切なしの場合を含む）に `mismatch` が確定した席は `pending` に戻る。再転記が段階 (4) に到達し、処理位置でラウンドが `OPEN` かつ席が `pending` で、初版から継承した締切適格性があれば、無効化版を差し替えられる（本書 §3.4・§4・§4.1）。差し替え版は新版の attest を待つ。無効化版は差し替え後も監督ビューに `reception: invalidated` のまま残る（§4.2a）。
- 締切スイープ後に `mismatch` が確定した席は、その確定時に `reason.code: "attest_mismatch"` で `absent` となる。
- 段階 (4) に到達した再転記の受理可否は、処理位置でのラウンドと席の状態、および初版から継承した締切適格性をそれぞれ確認する（§4.1）。ラウンドが `OPEN` でも席が `absent` または `waived` なら拒否し、ラウンドが凍結済みなら席の状態にかかわらず拒否する。拒否時は本節の `detail` と監査ログに判定事実を記録する。締切スイープより後に位置する再転記も、初版の締切適格性を継承する。

> 背景：実測で「全文と報告された転記が実際は改変されていた」事故があったため、この手順は省略不可とする。

---

## 5. 速報レーンと本答レーンの分離

- 本答（`answer` / `critique`）はバリア同期を経て確定し、統合の入力になる。
- `gate_decision` は議長ゲートの確定記録であり、`synthesis` は統合の出力である。
- 速報（flash）はバリア未成立の間、議長または速報担当として設定された席が出す「第一感」。統合の根拠として引用できない（§6）。
- `SeatConfig` の `flash` は任意の真偽値で、既定は `false` とする。`create_meeting` / `council.update_setup` で `flash: true` を指定した席が速報を提出できる。議長ロールの速報（`seat_id: "chair"`）は別枠とする。
- `submit_flash` では、速報担当席として呼ぶ場合は `seat_id` 引数に当該席の `seat_id` を渡し、議長として呼ぶ場合は `"chair"` を渡す。議長として提出したパケットの `seat_id` 欄には `"chair"` が入り、著者は議長ロールとなる。
- 議長ロールの速報（`seat_id: "chair"`）は、兼務する議長自身の席の状態にかかわらず、対象ラウンドが会議の現在の `OPEN` ラウンドである間は提出できる。 速報担当席としての提出には当該席の状態による制限が適用される（§4）。
- `submit_flash` は対象ラウンドが会議の現在の `OPEN` ラウンドでなければコアが拒否する（§4）。この検証を前提に、速報の内容規範と配布保留の条件は対象ラウンドを基準に適用する。バリア成立前に他席の当該ラウンド回答を引用・要約した `flash` を書いてはならない。共有規則に従い、凍結済み回答に含まれない席固有資料を速報に混ぜてはならない。
- 当該ラウンドの他席回答を読む権限を持つ principal（そのラウンドに参加していない議長等）が `OPEN` 中に提出した `flash` は、参加席への配布をバリア成立まで保留し、成立後に配布する。参加席自身の `flash` は即時に配布対象とする（§4.2a）。
- `note` にも速報と同じ内容規範を適用し、バリア成立前に他席の当該ラウンド回答を引用・要約してはならない。当該ラウンドの他席回答をバリア前に閲覧できる主体（議長や監督ビューの人間）が `OPEN` 中に投稿した `note` は、速報と同じ仕組みでバリア成立まで席への配布を保留し、成立後に配布する。共有規則に従い、凍結済み回答に含まれない席固有資料を `note` に混ぜてはならない。（§4.2a）
- 表示規則（表面共通）：速報には視覚的に区別可能なラベル（例: 「暫定」）を必須で付与し、本答が出た時点で同じスレッド位置に本答を追加する（速報を削除・上書きはしない。両方が履歴に残る）。
- 速報を出せるのは：(a) 待機中の議長（途中の論点整理）、(b) 速報担当として設定された席（最速応答席のローカル小モデル等）。高コスト席には速報目的の追加リクエストを送らない。

---

## 6. 議長統合（Synthesis）の入出力形式

`synthesize` の `invalid_state` では、`detail` に `meeting_state` を含め、必要に応じて `round` を追加する（§4.3）。

synthesisパケットは会議につき1回、`SYNTHESIZING` → `AWAITING_APPROVAL` への遷移時に生成する。ラウンド途中の議長による論点整理は `flash` として提出する（§5）。

`council.synthesize(meeting_id, body)` では、議長の種別にかかわらず、`body` は必須とし、省略した呼び出しはコアが拒否する。統合本文は議長エージェント自身、または人間議長の側で用意する。人間議長がエージェントの下書きを使う場合は、コアの外で得た本文を `body` として渡す。コアは統合本文を生成しない。議長は `body` に `agreements`、`minority_opinions`、`unverified_items`（未検証回答への参照の配列。各要素は `{ seat_id, packet_id }` で両値は文字列）、`missing_records`（自然文の欠落申告の配列。各要素は `{ seat_id, packet_id, note }` で各値は文字列）、`reversal_conditions`、`recommendation`、`cited_materials` を渡す。入力の `unverified_items` と `missing_records` はいずれも任意であり、それぞれの省略は「申告なし」（空配列）と同じ意味とする。コアは必須配列の `agreements`、`minority_opinions`、`reversal_conditions` と、`cited_materials` を検証する。コアは、入力の `unverified_items` と `missing_records` のいずれかに配列以外の値（`null` やオブジェクトを含む）が指定された場合、呼び出しレベルの型エラーとして `synthesize` 全体を拒否する。要素単位の破棄は、配列として渡された `unverified_items` と `missing_records` に限る。コアはこれらの配列で型や参照先に不備のある要素を個別に破棄し、監査ログに記録して統合処理を続ける。`cited_materials` には要素単位の破棄を適用せず、以下の引用の拒否契約に従って統合全体を拒否する。

議長は `reception_summary` を渡さない。コアは受領表からこれを計算し、渡された値があってもコアの計算値で置き換える。保存する `synthesis` の `body` は、議長の `agreements`、`minority_opinions`、`reversal_conditions`、`recommendation`、`cited_materials`、統合後の `unverified_items`、`declared_missing_records`、コアが計算した `reception_summary` で構成する。

構造化フィールドを持つ提出は、`claims` が空配列でも構造化提出として扱う。コアは `claims` が空配列の場合や、`statement` または `reversal_condition` が §3.3 の判定で欠落した主張がある場合に、欠落を機械的に検出し、凍結済み受領版について、その版にひも付けて記録する。欠落検出と記録は §3.3 に従い、空白の判定には §3.2 の定義を用いる。自然文経路は構造化フィールドが一切ない提出にのみ適用する。自然文のみの回答では、議長が統合作成時に読み取り、欠落があれば、対象版を `packet_id` で特定する `{ seat_id, packet_id, note }`（各値は文字列）の形で、提出する `missing_records` に含める。コアは、議長が申告した欠落記録について、`packet_id` が当該ラウンドの `seat_id` に対応する凍結済み受領版を指すこと、およびその受領版が構造化フィールドを一切持たない自然文の提出であることを検証し、両方を満たす有効な記録だけを `{ seat_id, packet_id, note }` の形で統合の `declared_missing_records` に保存する。凍結された受領版に一致しない申告や、構造化提出を対象とする申告は破棄し、監査ログに記録する。構造化提出ではコアの機械的な欠落記録を優先する。コア生成の欠落記録は、バリア凍結時点の現行版のうち、凍結済み受領版についてのみ保存する。これにより、統合に入る欠落記録をバリア凍結時点の現行版に限る規則が、自然文由来の記録にも機械的に適用される。構造化提出の欠落記録はコア生成と分かる形で記録する。差し替え済みの旧版の欠落記録は保存しない。議長が宣言しなかった自然文の欠落は記録されず、その判定と宣言は議長の責任とする。（§3.3）

```json
{
  "header": { "...": "共通ヘッダ, kind: synthesis" },
  "body": {
    "reception_summary": "string (受領表からコアが生成する表示用文字列。例: '受領1/2・免除1'。クォーラム未達の場合はその旨も付記)",
    "cited_materials": [{ "material_ref": "seat:seat_a:notes" }],
    "agreements": ["string"],
    "minority_opinions": [
      { "seat_id": "string", "opinion": "string" }
    ],
    "unverified_items": [
      { "seat_id": "string", "packet_id": "string", "state": "string", "source": "chair" },
      { "seat_id": "string", "packet_id": "string", "state": "string", "source": "core", "missing": ["statement", "reversal_condition"] }
    ],
    "declared_missing_records": [
      { "seat_id": "string", "packet_id": "string", "note": "string" }
    ],
    "reversal_conditions": [
      { "claim": "string", "condition": "string", "source_seat": "string" }
    ],
    "recommendation": "string | null (議長としての推奨。人間の承認対象)"
  }
}
```

**引用の宣言と確認**。議長は統合本文が依拠するすべての席固有資料と、証拠として引用するすべてのパケットを `cited_materials` に宣言しなければならない。パケットにも資料と同じ宣言規則を適用し、`packet:` 参照を用いる。各要素は `{ material_ref: string }` とし、参照は §4.2a の `packet:<packet_id>` または `seat:<seat_id>:<item_id>` 形式を用いる。引用がなければ空配列とする。統合の引用認可では、`seat:<seat_id>:<item_id>` 形式の参照に限って、参照先の席の `sharing_policy` を照合する。`packet:<packet_id>` 形式は、凍結済み回答など既に会議の配布規則の対象である当該会議内のパケットを指す。`packet:` 参照で引用できるのは、凍結された受領版の `answer` / `critique`、現行版（差し替えられていない版）の `agenda`、`gate_decision` に限り、共有確認は不要とする。差し替え済みの `agenda` は、`oversight` の認可を持つ当該会議の召集者・議長・人間参加者が監督ビューで閲覧できる。議長の申告上の義務として、統合本文で引用・転載・言及できる議題は現行の `agenda` に限る。議長は差し替え済みの `agenda` の内容を統合本文で引用・転載・言及してはならない。機械的検証は `cited_materials` の参照チェックで行う。`flash`、差し替え済みの `agenda`・回答版（`answer` / `critique`）、未検証の版は引用できない。議長が速報の内容を自分の言葉で述べ直したものは、議長自身の暫定の記述として扱う。速報の引用には当たらず、速報を `cited_materials` に宣言しない。統合本文では、議長自身の記述であり、暫定・未検証であることが分かるように示す。速報の内容を席の証拠として扱う場合は、その席のバリアで確定した本答を用いる。`no_share` は確認記録があっても引用不可とし、`share_with_confirmation` は当該会議で `material_ref` と用途 `cite_in_synthesis` が一致し、`setup_version` が会議の現在の値と一致する確認記録がある場合に限り引用を認める。`share_with_seat` は引用不可とする（統合は席ではない）。`share_freely` は確認記録なしで引用を認める。

コアは段階 (3) で `cited_materials` の資料参照とパケット参照を解決し、存在しない参照があれば段階 (4) に先立って `not_found` を返す。段階 (4) で引用不可の資料参照またはパケット参照が1つでもあれば、統合全体を `invalid_state` として拒否する。`detail` は `{ meeting_state, offending_materials }` とし、`offending_materials` は参照文字列の配列（`string[]`）とする。抵触した参照は、提出された `material_ref` の文字列のまま、それぞれ1回だけ `cited_materials` における初出順に並べる。会議状態も不適合であれば、段階 (4) で該当する判定事実をすべて `detail` に含める。

`cite_in_synthesis` の確認が許可する範囲は、対象資料を `synthesis` に含めることと、その `synthesis` を会議の全参加主体に配布することまでとする。これは席固有資料の会議内開示の正規の経路である。§8.1 の資料そのものの返却禁止は、`get_state` / `get_packets` での項目内容の提供に適用し、議長がこの経路で統合本文に引用することには適用しない。§4.2a のラウンドパケット（`answer` / `critique`）への混入禁止は、統合での引用には適用しない。

**保存する統合の4必須フィールドの型**：`agreements` / `minority_opinions` / `unverified_items` / `reversal_conditions` は常に配列として保持し、省略不可。`agreements` / `minority_opinions` / `reversal_conditions` の空配列は「確認済みゼロ件」を意味する。これら3フィールドの表示では、空配列を検出した場合にのみ「なし」のような文言で描画してよいが、これは表示上の変換であり、データ上は常に配列である。`unverified_items` の空配列は「記録された未検証事項なし」を意味する。自然文の未宣言の欠落がないことまでは保証しない。表面はこの空配列を「記録なし」と表示する。

保存する `unverified_items` の全要素は `seat_id`、`packet_id`、`state`、`source` を持つオブジェクトとし、文字列だけの要素は存在しない。コアは議長が渡した未検証回答への参照に `source: "chair"`、コア生成の欠落記録に `source: "core"` を設定する。コアは欠落のある凍結済み受領版につき1つの要素を保存し、欠落したフィールド名を文字列配列 `missing` に格納する。`missing` には、欠落した構造化提出のスキーマに定義されたフィールド名をそのまま使い、版ごとに重複なく（集合として）記録する。v1 では主張ごとの粒度は記録しない。たとえば、`claims` が空配列なら `missing: ["claims"]` と記録し、ある主張で両フィールドが欠落していれば `missing: ["statement", "reversal_condition"]` と記録する。議長申告の要素には `missing` を付けない。議長が申告した欠落の内容は `declared_missing_records` の `note` に保存する。

コアは `unverified_items` の各要素について、`packet_id` が当該会議・当該 `seat_id` のパケットを指すことを照合する。コア生成の欠落記録は、検出された提出版の `packet_id` と `seat_id` を保持し、その値で照合する。参照を解決できない要素は破棄し、監査ログに記録する。議長が申告した未検証回答への参照は、参照先の版の `kind` が `answer` または `critique` で、かつ `packet_state.verification` が `unverified`（attest 未確定・不一致を含む）の場合に限り保存する。検証済みの回答、`flash` など条件外の参照は破棄し、監査ログに記録する。この条件を満たせば、差し替え済みの版も参照できる。

合意の根拠に使える回答は、§5 に従ってバリアで確定した本答に限る。`waived` や `absent` で閉じた席の attest 未確定の版を含め、未検証回答は合意の根拠に一切使わない。未検証回答の本文や要約は `unverified_items` に含めない。コアは入力要素に `state` があっても無視し、保存時に受領記録から `state` を補う。当該パケットの `packet_state.reception` が `superseded` の場合、席の状態にかかわらず `state` は `superseded` とする。それ以外では、席が `waived` / `absent` で閉じた場合はその状態を、ほかの場合は当該パケットの `packet_state.reception`（§4.2a）を用いる。凍結時に attest 未確定の回答のうち、`state` が `transcribed_pending_attest` となり得るのは有効な現行転記版だけである。

**受領集計**：バリア凍結時点の `reception_table`（§4）の当該ラウンドの行を最終とし、後から到来する締切スイープは何も処理しない（§4.1）。コアはこの受領表から集計し、ラウンド別（`R0`/`R1`/`R2`。R2が実施されなかった会議では省略）に `{total, received, absent, waived, quorum_met}` のオブジェクトを作る。件数4項目は整数とする。コアはバリア凍結時に `received` の必須席の数を §4.1 の `quorum` と比較し、達成なら `true`、未達なら `false`、未設定なら `null` とする。任意席の受領は `quorum_met` の判定から除外する。全席の受領状態が確定している場合、`total = received + absent + waived` が成立する。凍結時点で `pending` の任意席は `absent` として集計する。`absent` に遷移した席は §4 の規則で当該ラウンドの履歴に基づいて記録した `reason.code` を使って集計する。集計表記は、`deadline_no_submission` が「未提出」、`attest_mismatch` が「有効な提出なし（attest 不一致）」、`chair_declared` が「議長宣言」とする。凍結時点で `pending` のまま集計上 `absent` とする任意席は、当該ラウンドに attest 不一致で無効化された版があれば「有効な提出なし（attest 不一致）」、本答・批評（Web 席の転記を含む）の提出がなければ「未提出」とする。欠席理由の判定では速報とメモを提出に含めない（§4.1）。理由の先頭には「任意席・」または「必須席・」を付ける。`transcribed_pending_attest` の任意席は「attest 未確定」として記録する。いずれもクォーラムには数えない。attest 未確定の回答本文は受領済み回答として配布せず、統合にも含めない。「attest 未確定」の席は `total` に含め、`received` / `absent` / `waived` の件数には含めない。`quorum_met` が `false` のラウンドがある場合、`reception_summary` にその旨を明記する（例: 「R1: 受領1/2・免除1（quorum未達）」）。`reception_summary` はこの集計と凍結時点の任意席の状態から生成する表示用文字列であり、受領表が一次データである。

バリア凍結で当該ラウンドは閉じ、コアは以後そのラウンドへの `submit_attest` を拒否する。凍結時点で未確定の attest は、当該ラウンドでは「attest 未確定」のまま記録される。監督ビューの受領値も、現行転記版と差し替え済みの旧版を区別して §4.2a・§4.3 に従う。

synthesisパケットに対する承認・却下・reopen（§1.4、新会議作成）は、当該会議の人間参加者が §8.1 に従って行う。

---

## 7. 表示規則（表面向けの最小要件）

表面（MCP/アプリ）が満たすべき最小要件：

- 速報と本答を視覚的に区別する（§5）。
- 受領状態（pending/transcribed_pending_attest/received/absent/waived）を席ごとに可視化する。`transcribed_pending_attest` は `pending` と「未検証（確認待ち）」バッジの組み合わせで表示し、このラベルとバッジの組み合わせは表面での描画に限り、API は `reception_table.state` に `transcribed_pending_attest` を返す（§4・§4.3）。
- attest 未確定の Web 席回答には明示マークを付ける。attest 不一致が確定した版は不一致と分かるように表示し、「未検証（確認待ち）」バッジは付けない。
- synthesisの4必須フィールドは省略せず、空配列の表示は項目ごとに判定する。`unverified_items` が空の場合は「記録なし」と表示する。`agreements` / `minority_opinions` / `reversal_conditions` が空の場合は、それぞれ「なし」等で表示してよい（§6）。

表示の詳細（画面設計）はPRODUCT.md側の責務。

---

## 8. 安全（プロトコルレベル）

- 外部席（CLI/API/Web）からの本文は、他席・議長への配布時に `<untrusted>...</untrusted>` 相当のラッピングを行う（事務局が自動付与。packet_sha計算には影響しない、本書 §3.4）。表面側はこのラップを除去して表示してよいが、他席への再配布時は必ずラップを維持する。
- 会議の正本（全パケット・synthesis・承認記録）は非公開の置き場に保存する。v1 のコアは公開ミラー転送や外部出力などの会議外共有を実行する操作を持たない。将来、資料を会議の境界の外へ運ぶ操作を追加する場合、席固有資料には §4.2a の `sharing_policy` を適用し、利用不可の資料の共有を拒否しなければならない。席固有資料以外の資料と、`share_with_confirmation` の席固有資料については、その操作の実行前に §4.2a の条件で確認記録を照合し、一致する記録がなければ操作を拒否する。公開ミラー転送を追加する場合は、デフォルトOFFとし、明示的なオプトイン操作を要する。
- **Web 席の接続は手渡しのみとし、Web UIの自動操作は行わない（凍結）。** これは実装の都合による制約ではなく、安全規範として固定する。ブラウザの自動操作・スクレイピング・ヘッドレス操作により「手渡し」を代替する実装は、将来のバージョンでも本プロトコルの範囲外とする。

### 8.1 呼び出し主体と権限

表面（MCP／アプリ／コア API 直接）によらず、すべての外部呼び出しに同じ認証済み主体（principal）モデルを適用する。コアは未認証の呼び出しを受け付けない。コアは principal を会議内の役割（当該席本人／その席の認可ドライバ／召集者／議長／人間）に写像し、ツールごとの権限と照合する。権限の不一致はエラーとして拒否する。

対象に依存しない認可は段階 (1) で行い、対象の検索に先行する。議長限定の操作では、非議長には対象席の存否にかかわらず `unauthorized` を返す。対象に依存しない認可を通過した呼び出し主体が存在しない席を指定した場合は、段階 (3) で `not_found` を返す。その席として行動する権限など、対象に依存する認可は対象の解決後に判定し、権限がなければ `unauthorized` を返す。検査順は §4.3 に従う。

`seat_id` は同一会議内で一意とする。コアは `create_meeting` / `council.update_setup` に渡された `seats` 配列内に重複する `seat_id` があれば呼び出しを拒否する。

各席の `SeatConfig`（PRODUCT.md §2.2・§3）に、席本人の認証済み principal 識別子である必須の `principal` と、その席のドライバとして認可される principal 識別子の配列である任意の `driver_principals` を指定する。`create_meeting` / `council.update_setup` での席の登録時に、コアは席と登録された principal のひも付けを保持する。呼び出し主体の認証済み principal が当該席の `principal` と一致すれば席本人として扱い、`driver_principals` に含まれればその席の認可ドライバとして扱う。認可ドライバは担当席の席ロール操作をすべて同じ権限で代理できる。これには席入力ビューでの取得と ack、`submit_answer`、速報担当席の `submit_flash` が含まれる。認可ドライバが監督ビューを使えるのは、その principal が独立に当該会議の召集者・議長・人間参加者のいずれかのロールを持ち、そのロールで監督ビューの認可条件を満たす場合に限る。 転記内容の確認の認証要件は §4.3 に従う。

v1 の議長は、席・人間・席を持たないエージェント principal のいずれでもよい。議長は `chair`（`ChairConfig`、PRODUCT.md §3）の必須フィールド `principal` で指定する。議長または監督ビューのアクセス権を持つ主体の認証済み principal が、ある席の `principal` と一致するか、その席の `driver_principals` に含まれる場合、その席を兼務すると判定する。他席の現行ラウンド回答に対するバリア前の監督ビューの閲覧制限は、本人として保持する席および代理できる席ごとに適用する。兼務時も認可は（principal, そのラウンドでの役割）ごとに評価し、バリア前の監督ビュー制限（§4.2a）を適用する。`ChairConfig.seat_id` は表示・整合のための任意項目とする。`seat_id` が指定されている場合、結果となる会議設定でその ID が議長 principal にひも付く本人の席を指していなければ、コアは `create_meeting` / `update_setup` を拒否する。席を持たない召集エージェントは `seat_id` を省略し、自分の認証済み主体の識別子を `chair.principal` に指定する。

会議の人間参加者は、人間の召集者、人間議長、および `create_meeting` または `council.update_setup` の `human_participants` に登録された人間とする。`human_participants` は認証済みの人間 principal の識別子の配列とする。

| ツール | 呼び出し条件 |
|---|---|
| `create_meeting` | 認証済み主体なら可。呼び出し主体を召集者として記録する。必須引数 `chair` で議長を指定し、任意引数 `human_participants` で人間参加者を登録する。 |
| `update_setup` | `CREATED` の間のみ、召集者または議長の principal が呼び出せる。`human_participants` で登録する人間参加者の配列を差し替えられる。R0開始後はコアが拒否する（§1.3）。 |
| `open_round` | 議長 principal のみ。R0 は会議が `CREATED` の場合に限り、R1 は会議が `GATE(R0)` の場合に限り受理する。開始操作内で即時凍結する場合は、それぞれ `GATE(R0)`・`GATE(R1)` で議長操作を待つ（§4.1）。R0開始時点で人間参加者（人間の召集者・人間議長・`human_participants` に登録された人間）が0人なら、コアは `council.open_round` を拒否する。 |
| `submit_flash` | 議長、速報担当として設定された席本人、またはその席の認可ドライバのみ。 |
| `post_message` | 当該会議の人間参加者と議長のみ。`note` を投稿できるのは会議が `CREATED`・`OPEN`・`GATE(round)`・`SYNTHESIZING`・`AWAITING_APPROVAL` の間に限る。コアは `APPROVED`・`REJECTED` での投稿を拒否する。reopen の場合は新会議に投稿する。 |
| `confirm_share` | 当該会議の参加者である人間 principal（§8.1 の人間参加者の定義に従う）のみが呼び出せる。会議の参加者でない人間からの呼び出しはコアが拒否する。（資料参照、用途、宛先、`setup_version`）の組を記録する。共有ポリシーと設定版の検査は §4.2a に従う。`share_external` は、人間がコアの外で資料を手作業で共有する際、確認が必要な場合に事前に作る確認記録である。コアは `council.synthesize` の受け付け時に席固有資料の引用可否を判定する（§4.2a・§6）。 |
| `get_state` | 当該会議の席本人・席の認可ドライバ・召集者・議長・人間参加者のみ。召集者は自分が召集した会議の監督読み取りができる。席の認可ドライバが呼び出す場合は、担当席について席本人と同じ席入力ビューを受ける。当該会議のどの席の認可ドライバでもなく、会議内の他の認可された役割も持たない呼び出し主体には `unauthorized` を返す。`council.get_state` は各席の `seat_specific_materials` の項目一覧を当該席本人・その席の認可ドライバ・議長・当該会議の人間参加者にのみ返す。各項目には `id` と当該席の `sharing_policy` を含める。一覧を返す場合、文脈契約の `seat_specific_materials_count` は省略する。一覧の閲覧権限がない呼び出し主体には、文脈契約に整数の `seat_specific_materials_count` を載せ、`seat_specific_materials` は省略する。席固有資料の項目内容はコアの外にある。コアは `get_state` / `get_packets` の応答で席固有資料の項目内容そのものを返さない。議長は `cite_in_synthesis` の確認に基づき、統合本文で資料を引用できる（§6）。 |
| `get_quota` | 当該会議の参加主体（席・議長・人間）のみ。 |
| `get_packets` | 当該会議の席・議長・人間参加者、および自分が召集した会議を監督ビューで読む召集者。担当席の代理とビュー別の認可は §4.2a に従う。 |
| `submit_answer` | 対象席本人またはその席の認可ドライバのみ。 |
| `transcribe_web_seat` | 当該会議の召集者 principal（運用者）、対象席にひも付く認証済み principal（席本人）、またはその席の認可ドライバのみが呼び出せる。コアは他の参加者からの呼び出しを拒否する。 |
| `submit_attest` | `verbatim_confirm` と後継版の `hash_match` はいずれも、当該会議の召集者 principal（運用者）、対象 Web 席の認証済み principal（席本人）、またはその席の認可ドライバのみが呼び出せる。§4.3 の順序に従い、形式検査（手順0）→ 検索前認可 (a) → 検索 (b) → 対象席認可 (c) → 検索を要する証拠の引数検証（後継版の `hash_match`、段階 (2)）→ 状態検査 (d) の順に判定する。(a) では当該会議の召集者またはいずれかの Web 席の本人・認可ドライバであることを確認し、`evidence.confirmer` が認証済みの呼び出し主体の識別子と異なる場合も `unauthorized` を返す。対象 Web 席に基づく認可は (c) で行う。 |
| `approve` | 承認・却下・reopen は当該会議の人間参加者のみが `AWAITING_APPROVAL` で実行できる。コアは非参加の人間からの呼び出しを拒否する。決定は状態遷移により一度だけ効力を持ち、`AWAITING_APPROVAL` を抜けた後の `approve` は拒否する。 |
| `chair_gate` | 議長 principal のみ。コアは会議が `GATE(R1)` の間だけ `chair_gate` を受理する。判定を `gate_decision` として記録すると同時に、Pass なら `SYNTHESIZING` に遷移し、Fail なら `OPEN(R2)` に遷移する。Fail で開いた R2 がその操作内で即時凍結する場合は、同じ操作で `SYNTHESIZING` へ進む（§4.1）。コアは `result: "pass"` と `r2_deadline` の同時指定を `invalid_argument` として拒否する。遷移後の再呼び出しは、会議が `GATE(R1)` ではないため拒否する。 |
| `synthesize` | 議長 principal のみ。コアは会議が `SYNTHESIZING` の間だけ受理し、`AWAITING_APPROVAL` への遷移後の再呼び出しは拒否する。 |
| `waive_seat` / `declare_absent` | 議長 principal のみ。 |

`submit_answer` と `transcribe_web_seat` の呼び出し主体の権限は、対象席の接続種別を問わずに判定する。接続種別の適格性は §4.1・§4.3 に従って段階 (4) で判定する。

席の接続種別は席の登録情報であり、文脈契約の一部とする。Web 席の回答は `transcribe_web_seat` 経由でのみ受け付ける。コアは Web 席を対象とする `submit_answer` を認可ドライバ経由でも拒否し、拒否を会議の操作ログに記録する。Web 席の回答が attest を経ずに `received` に進む経路はない。

`get_packets` の認証済み principal と `caller_seat_id` の照合およびパケットの認可範囲には §4.2a を適用する。席入力ビューの `ack_packet_ids` は現行の `delivery_epoch` を伴い、受理条件を満たす場合に、照合済みの配布先の ack 済み集合に反映する（§4.2）。

---

## 9. クォータ

- `SeatConfig` は必須の `connection: "cli" | "api" | "web" | "local"` を持つ（PRODUCT.md §3）。接続種別はクォータの既定値・上限と提出経路を決め、`connection: "web"` の席の回答は `transcribe_web_seat` 経由でのみ受け付ける。接続種別は `council.update_setup` で `CREATED` の間だけ変更できる。変更時、コアは新しい種別の上限を適用し、クォータを含む更新後の設定全体を再検証する。
- クォータは席ごと・会議単位の提出受理件数の上限とする。Web 席（手渡し）は既定値4、最大6とし、CLI・API・ローカル席は既定値10、最大20とする。入力の `SeatConfig.quota` は省略可能とし、指定する場合は1以上かつ接続種別の最大値以下の整数とする。範囲外または非整数の指定は `create_meeting` / `council.update_setup` が拒否する。席の作成時（`create_meeting` または `council.update_setup` による席の追加時）に `quota` を省略した場合は、接続種別の既定値を具体的な整数として設定に保存する。保存済みの各席の `quota` は常に具体的な整数とする。既存席の更新では、省略時の保存値の保持と、接続種別変更時の段階 (2) の検証を §1.3 に従って行う。能力ラベルは設定者（人間・議長）が設定値を選ぶ際の参考情報であり、コアは能力ラベルからクォータを導出しない。
- コアは `submit_answer` / `submit_flash` / `transcribe_web_seat` の席への提出を受理するたびに、当該席の消費を1増やす。差し替え版もそれぞれ数える。Web 席の転記は attest の前に、転記を受理した時点で数える。議長ロールでの速報（`seat_id: "chair"`）は席の消費に含めない。
- クォータの強制点はコアの提出受理判定とする。形式検査・認可・引数検証・参照先の存在確認の後、状態段階でクォータを判定し、上限を超える提出は `invalid_state` で拒否する。状態段階では該当する判定事実をすべて `detail` に含める。クォータ超過時は操作の標準キーに加えて `quota_exceeded: true` を含める。凍結とクォータ超過が重なれば、`round_frozen: true` と `quota_exceeded: true` の両方を返す。受理と消費の加算は一体で行う。
- `get_quota` は助言的な事前確認とする。上限到達を確認した事務局は追加依頼を見送り、議長に判断を戻す。
