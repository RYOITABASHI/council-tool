# PRODUCT.md — 首脳会議ツール 製品仕様 v9.15

ステータス: Draft（設計中、実装前）— v9.15（Codexレビュー反映・議長裁定反映）
前提: 本書のプロトコル用語・状態機械は [PROTOCOL.md](./PROTOCOL.md) に従う。

---

## 1. コアと表面の責務分界

### 1.1 コア（事務局エンジン）

責務：
- 会議の遷移（PROTOCOL.md §1）・ラウンドプロトコル（§2）の実行。`create_meeting` でtopicを受け取り `CREATED` で会議を作成する。議長の `open_round` で `OPEN(R0)` へ遷移させる。
- パケットの生成・ハッシュ計算（packet_sha、PROTOCOL.md §3.4）・保存・配布（全文/差分）。packet_shaは暗号学的署名ではなく一方向ハッシュであり、本書でも「署名」という語は使わず「ハッシュ計算」に統一する。
- 受領状態機械（pending/transcribed_pending_attest/received/absent/waived）の管理、締切・クォーラムの判定（PROTOCOL.md §4.1）。
- attestの受理・検証（PROTOCOL.md §4.3）。`verbatim_confirm` では手続きの検証後に認証済み確認者の申告結果を採用し、後継版の `hash_match` ではコア自らの照合結果を採用する。
- `get_packets` の認可フィルタと席入力ビューの配布済み `packet_id` の管理（PROTOCOL.md §4.2・§4.2a）。
- クォータ消費の追跡とブロック判定。
- 議長統合（synthesis）の生成支援。統合本文は AI または人間議長が作成し、コアは入力の型チェックと受領数の自動集計を行う。統合本文の `agreements`、`minority_opinions`、`unverified_items`、`reversal_conditions` の4フィールドはすべて保存・表示で必須とする。入力の `unverified_items` は省略でき、省略時は空配列として扱う。
- 正本の永続化（非公開置き場、v1はファイルベース — 詳細はPLAN.md）。

コアが**持たないもの**：
- UI/表示ロジック一切。
- 参加プロセスの起動。コア（状態機械）はパケットの受理・配布を担い、プロセスを起動しない。
- **Web UIの自動操作は、コアにも表面にも存在しない**（PROTOCOL.md §8で凍結された安全規範）。Web 席は人間による手渡し転記が唯一の経路であり、「表面の責務」として自動操作を代替実装することも許されない。

エージェントの実行経路は以下の2つとする。

- **ドライバ経路**（v1のCLI席の主経路）。事務局ホスト側のアダプタ層がCLIをサブプロセスとして起動し、プロンプトを渡し、出力を席に代わって `council.submit_answer` 等で提出する（PLAN.md §1）。
- **直接MCP経路**。独立に稼働中のエージェントが自分で `council.submit_answer` 等のMCPツールを呼ぶ。

### 1.2 表面（MCPサーバ／アプリ）

優先順位：(1) MCPサーバ → (2) スマホアプリ → (3) Webアプリ（後回し）。

- **MCPサーバ**：コアをツール群として公開する薄いアダプタ。直接MCP経路では、独立に稼働するエージェントがMCPクライアントとして接続する。人間がCLI経由で会議を操作する際もここを通る。
- **アプリ（Expo/React Native）**：人間向けのLINE風チャットUI。席の実行はサーバ側（VM/PC）にあり、アプリは薄いクライアント（表示・入力・通知のみ、コアロジックを持たない）。Shelly 上で動く席は将来フェーズで扱い、v1 の範囲外とする（PLAN.md 参照）。
- **Webアプリ**：後回し。ブラウザ自動化は行わない方針（PROTOCOL.md §8、凍結された安全規範）のため、Web 席は常に「手渡し」経由であり、Webアプリ自体は主に人間向けの別UIとしての位置づけになる（v1スコープ外、PLAN.md参照）。

両表面は同一のコアAPIを呼ぶ。表面間でロジックの重複を持たない。

会議タイムアウトの判定と `timeout_exceeded` フラグの設定はコアが担う。MCP を経由しない表面でも、同じコア API から同じフラグ状態を観測できる。会議タイムアウトに関する表面の責務は、コアが返すフラグに基づく表示と通知に限る（PROTOCOL.md §1.5）。

---

## 2. 席のモデル（実装視点）

PROTOCOL.mdの前提通り、席は3軸＋文脈契約で定義される。

### 2.1 席の3軸

| 軸 | 値の例 |
|---|---|
| 接続手段 | `web`（Web 席の手渡し） / cli（ローカルCLIエージェント） / api（API課金） / local（ローカルモデル） |
| 利用条件 | subscription（サブスク） / api_billed（API課金） / free（無料） |
| 能力 | 任意のラベル（例: "long_context", "code_execution_readonly", "fast_small"） — クォータは保存済みの `SeatConfig.quota` で決まる（§3）。能力ラベルは設定者（人間・議長）が設定値を選ぶ際の参考情報であり、コアは能力ラベルからクォータを導出しない。 |

### 2.2 文脈契約（context contract）

席の登録に使う `SeatConfig` には、以下の文脈契約に加え、席本人の認証済み principal 識別子である必須の `principal` と、その席のドライバとして認可される principal 識別子の配列である任意の `driver_principals` を指定する。`create_meeting` / `council.update_setup` での席の登録時に、コアは席と登録された principal のひも付けを保持する。呼び出し主体の認証済み principal が当該席の `principal` と一致すれば席本人として扱い、`driver_principals` に含まれればその席の認可ドライバとして扱う。（PROTOCOL.md §8.1）

| SeatConfig フィールド | 必須性 | 省略時の扱い |
|---|---|---|
| `seat_id` | 必須 | — |
| `principal` | 必須 | — |
| `connection` | 必須 | — |
| `role` | 任意 | 特別な役割なし |
| `shared_materials` | 任意 | 空配列 |
| `seat_specific_materials` | 任意 | 空配列 |
| `sharing_policy` | 任意 | `share_with_confirmation` |
| `tool_access` | 任意 | 接続種別を問わず `"none"` |
| `driver_principals` | 任意 | 認可ドライバなし |
| `optional` | 任意 | `false`（必須席） |
| `flash` | 任意 | `false` |
| `quota` | 任意 | Web 席は 4、CLI・API・ローカル席は 10（PROTOCOL.md §9） |

`RoundSettings` の各ラウンドで `deadline` と `quorum` はそれぞれ独立に任意とする。`quorum` だけの指定も有効とする（§3・§5）。

```json
{
  "seat_id": "string",
  "role": "string (この席の役割の説明)",
  "shared_materials": ["string (共通資料への参照ID)"],
  "seat_specific_materials": [{ "id": "string (この席固有の資料・会話履歴への参照ID)" }],
  "sharing_policy": { "kind": "share_with_seat", "seat_ids": ["seat_b"] },
  "tool_access": "none | readonly_sandbox | full"
}
```

- 席の接続種別は、席の登録時に指定する接続手段（§2.1・§5）であり、文脈契約の一部とする。
- 共通資料と席固有文脈は分離して保存する。`council.get_state` は各席の `seat_specific_materials` の項目一覧を当該席本人・その席の認可ドライバ・議長・当該会議の人間参加者にのみ返す。各項目には `id` と当該席の `sharing_policy` を含める。一覧を返す場合、文脈契約の `seat_specific_materials_count` は省略する。一覧の閲覧権限がない呼び出し主体には、文脈契約に整数の `seat_specific_materials_count` を載せ、`seat_specific_materials` は省略する。席固有資料の項目内容はコアの外にある。コアは `get_state` / `get_packets` の応答で席固有資料の項目内容そのものを返さない。議長は `cite_in_synthesis` の確認に基づき、統合本文で資料を引用できる（PROTOCOL.md §6）。（§3）
- `confirm_share` の対象は席固有資料（`seat:<seat_id>:<item_id>`）に限る。`packet:<packet_id>` が渡された場合は、対象の種別の不一致として段階 (0) で `invalid_argument` を返す。パケットの配布は配布規則（配信集合）に従い、統合での引用は回答の引用規則に従う（PROTOCOL.md §4.2・§4.2a・§6）。
- `material_ref` は名前空間つき文字列とする。パケット由来の資料は `packet:<packet_id>`、文脈契約由来の席固有資料は `seat:<seat_id>:<item_id>` とする。`item_id` は当該席の `seat_specific_materials` の項目の文字列 `id` である。`seat_id` と席固有資料の項目の `id` は `[A-Za-z0-9_-]+` に制限する。この制限により、上記の名前空間形式は `:` で一意に分解できる。コアは `create_meeting` / `update_setup` での登録時に、`:` を含むなどこの制限に違反する ID や、同じ席の `seat_specific_materials` 内で重複する `id` があれば登録を拒否する。`"chair"` と `"human"` は予約語とし、コアは `create_meeting` / `update_setup` でこれらを `seat_id` として登録する要求を拒否する。議長は統合本文が依拠するすべての席固有資料と、証拠として引用するすべてのパケットを `cited_materials` に宣言しなければならない。パケットにも資料と同じ宣言規則を適用し、`packet:` 参照を用いる。各要素は `{ material_ref: string }` とし、引用がなければ空配列とする。（PROTOCOL.md §4.2a・§6）
- 会議内で凍結された回答は席が会議に提出した寄稿そのものであり、会議内での配布を `sharing_policy` で制限しない。事務局・議長は、凍結済み回答に含まれない席固有資料を他席に配布するラウンドパケット（`answer` / `critique`）に混ぜてはならない。この規則は統合での引用には適用しない。統合での引用は PROTOCOL.md §6 に従う。席固有資料の利用可否は席の `sharing_policy` に従う。
  - `no_share` の資料は確認記録があっても一切利用できず、コアはその資料を対象とする `council.confirm_share` を拒否する。
  - `share_with_confirmation` の資料は、資料参照、用途、宛先（必要な場合）が一致し、`setup_version` が会議の現在の値と一致する確認記録がある場合に限り引用・共有できる。
  - `share_freely` の資料は確認記録なしで引用・共有できる。
- `cite_in_synthesis` の確認が許可する範囲は、対象資料を `synthesis` に含めることと、その `synthesis` を会議の全参加主体に配布することまでとする。これは席固有資料の会議内開示の正規の経路である。（PROTOCOL.md §4.2a・§6）
- `sharing_policy` の値は `"no_share"`、`"share_with_confirmation"`、`"share_freely"`、または `{ kind: "share_with_seat", seat_ids: string[] }` とする。指名する宛先席の集合は、このオブジェクトの `seat_ids` に格納する。`share_with_seat` ポリシーが許可する用途は、その集合に含まれる席への席間共有に限る。
- `seat_ids` の各要素が作成後または更新後の設定に含まれる席の `seat_id` であることを検証する。`create_meeting` ではリクエスト内の席だけで判定できるため、段階 (0) で検証する。`update_setup` ではリクエストで省略された既存席も更新後の設定に残るため、保存済みの現行設定を参照し、段階 (2)（検索を要する引数検証）で検証する。どちらの操作でも、該当する席のない要素があれば `invalid_argument` を返す。（§3）
- 確認が必要な場合、アプリでは確認ダイアログを用い、手作業の会議外共有に先立つ確認は §3 の `share_external` で記録する。v1 のコアは席固有資料を他席へ個別に届ける操作を持たない。`share_with_seat` は `share_external` と同様に、人間がコアの外の経路で対象席へ資料を渡す前に作る確認記録である。将来、席間へ資料を届ける操作を追加する場合、コアは実行前に資料参照、用途、宛先、現在の `setup_version` が一致する確認記録を照合し、一致する記録がなければ操作を拒否しなければならない。
- 統合の受領集計にはバリア凍結時点の状態を用いる。凍結時点で `pending` の任意席は `absent` として集計する（理由の表記は PROTOCOL.md §6）。`transcribed_pending_attest` の任意席は「attest 未確定」として記録する。いずれもクォーラムには数えない。attest 未確定の回答本文は受領済み回答として配布せず、統合にも含めない。バリア凍結で当該ラウンドは閉じ、コアは以後そのラウンドへの `submit_attest` を拒否する。凍結時点で未確定の attest は、当該ラウンドでは「attest 未確定」のまま記録される。凍結後の監督ビューで attest 未確定を `packet_state.reception: transcribed_pending_attest` として返すのは、有効な現行転記版に限る。attest 未確定のまま差し替えられた旧版は `packet_state.reception: superseded` として返す。統合に保存する `unverified_items.state` もこの版の区別に従う（PROTOCOL.md §4.2a・§4.3・§6）。
- 合意の根拠に使える回答はバリアで確定した本答に限る。`waived` や `absent` で閉じた席の attest 未確定の版を含め、未検証回答は合意の根拠に一切使わない。統合に保存する `unverified_items` の各要素は `{ seat_id, packet_id, state, source }` とし、`source` が `"core"` の場合に限り `missing: string[]` を付ける（PROTOCOL.md §4.3・§6）。
- `sharing_policy` のデフォルトは `share_with_confirmation`。`share_freely` を使う席は、会議設定（§5）で明示的にその値を選んだ場合に限る。
- `tool_access` の省略時は接続種別を問わず `"none"` とする。サンドボックスが必要な CLI 席は `tool_access: "readonly_sandbox"` を明示する（PROTOCOL.md §8）。文脈契約の `tool_access` フィールドが、その席に許可するツール権限の範囲を定める。

---

## 3. MCPツール一覧

ツール名・引数・返り値は本バージョンで確定しており、変更には仕様改訂を要する。

`Deadline` 型の値は `{ kind: "absolute", at: ISO 8601 タイムスタンプ }` または `{ kind: "relative", seconds: 正の整数 }` のいずれかとする。相対期間の単位は秒とする。絶対締切の `at` にはタイムゾーン指定（`Z` または `±hh:mm`）を必須とする。タイムゾーンのないタイムスタンプはローカル時刻として解釈せず、`invalid_argument` で拒否する。呼び出し時の絶対締切の上書きが処理時点より厳密に過去の場合も `invalid_argument` で拒否する（PROTOCOL.md §4.1）。`RoundSettings` 型は `{ R0?: { deadline?: Deadline | null, quorum?: integer }, R1?: { deadline?: Deadline | null, quorum?: integer }, R2?: { deadline?: Deadline | null, quorum?: integer } }` とする。`create_meeting` はこの型の `round_settings` を受け付ける。各ラウンドの `deadline` と `quorum` は独立に省略できる（§2.2）。ラウンド別の `quorum` は任意で、未指定のラウンドにはトップレベルの `quorum` を既定値として適用する。`quorum` は受領集計で達成と判定するために必要な必須席の受領数を表す。`create_meeting` / `council.update_setup` のどちらでも、設定するクォーラムの値はトップレベルとラウンド別のいずれも1以上かつ席数以下の整数とする。

`meeting_timeout` は秒単位の正の整数とし、`create_meeting` / `council.update_setup` で指定できる。既定値は 259200 秒（72時間）。0以下の値と非整数は拒否する。仕様上の上限は定めない。

v1 のコアは公開ミラー転送や外部出力などの会議外共有を実行する操作を持たない。コアは `council.synthesize` の受け付け時に席固有資料の引用可否を判定する（PROTOCOL.md §4.2a・§6・§8）。

`SeatConfig` は必須の `principal: string` と必須の `connection: "cli" | "api" | "web" | "local"`、および任意の `driver_principals?: string[]`、`quota?: integer`、`optional?: boolean`、`flash?: boolean` を持つ。`SeatConfig` の `flash` は任意の真偽値で、既定は `false` とする。`create_meeting` / `council.update_setup` で `flash: true` を指定した席が速報を提出できる。議長ロールの速報（`seat_id: "chair"`）は別枠とする。`seat_id` は同一会議内で一意とし、`create_meeting` / `council.update_setup` は `seats` 配列内の `seat_id` の重複を拒否する。席は既定で必須席とし、`optional: true` の席だけが任意席となる。任意席はバリア成立を妨げない。バリアで `received` として凍結された任意席の回答は配布する。`quorum` は `received` の必須席の数と比較し、任意席は数えない（PROTOCOL.md §4.1・§6）。入力の `SeatConfig.quota` は省略可能とし、指定する場合は1以上かつ接続種別の最大値以下の整数とする。範囲外または非整数の指定は `create_meeting` / `council.update_setup` が拒否する。席の作成時（`create_meeting` または `council.update_setup` による席の追加時）に `quota` を省略した場合は、接続種別の既定値を具体的な整数として設定に保存する。保存済みの各席の `quota` は常に具体的な整数とする。接続種別はクォータの既定値・上限と提出経路を決め、`connection: "web"` の席の回答は `transcribe_web_seat` 経由でのみ受け付ける。接続種別は `council.update_setup` で `CREATED` の間だけ変更できる。既存席の `council.update_setup` で `quota` を省略した場合は、保存値を保持し、既定値は再適用しない。接続種別を変更するときは、保存済み設定を参照し、更新後の設定全体を新しい接続種別の制約で段階 (2) において再検証する。省略により保持した `quota` が新しい種別の上限を超える場合、更新は `invalid_argument` で拒否する。変更を通すには、同じ更新で新しい種別の範囲内の `quota` を明示する必要がある。席の登録時のひも付けと文脈契約は §2.2 に従う。議長の設定型は次のとおりとする。

```ts
type ChairConfig = {
  principal: string
  display_name?: string | null
  seat_id?: string
}
```

`principal` は必須であり、認証済み主体の識別子を指定する。v1 の議長は、席・人間・席を持たないエージェント principal のいずれでもよい。議長または監督ビューのアクセス権を持つ主体の認証済み principal が、ある席の `principal` と一致するか、その席の `driver_principals` に含まれる場合、その席を兼務すると判定する。他席の現行ラウンド回答に対するバリア前の監督ビューの閲覧制限は、本人として保持する席および代理できる席ごとに適用する。兼務時も認可は（principal, そのラウンドでの役割）ごとに評価し、バリア前の監督ビュー制限（PROTOCOL.md §4.2a）を適用する。`ChairConfig.seat_id` は表示・整合のための任意項目とする。`seat_id` が指定されている場合、結果となる会議設定でその ID が議長 principal にひも付く本人の席を指していなければ、コアは `create_meeting` / `update_setup` を拒否する。席を持たない召集エージェントは `seat_id` を省略し、自分の認証済み主体の識別子を `chair.principal` に指定する。（PROTOCOL.md §8.1）

**update_setup の入力スキーマ**

`ChairUpdate` と `SeatUpdate` は、それぞれ `ChairConfig` と `SeatConfig` のフィールドを部分指定する更新専用型とする。`SeatUpdate` では照合に使う `seat_id: string` が必須となる。`RoundSettingsUpdate` は `RoundSettings` と同じラウンド・フィールド構成の部分オブジェクトとし、以下の規則で明示的な `null` を受け付ける。

`chair` は部分オブジェクトとし、指定されたフィールドだけを更新する。`seats` の各エントリは必須の `seat_id` で既存の席と照合し、一致する席では指定されたフィールドだけを更新する。新しい `seat_id` のエントリは席の追加とし、作成時の必須フィールド（`seat_id`、`principal`、`connection`）がそろわなければ `invalid_argument` を返す。配列から省いた席は残る。v1 では `update_setup` で席を削除できない。

更新時に渡した `seats` 配列が更新前の全席の `seat_id` を含む場合は、新規席も含めて、その配列の順序を更新後の全体の並びとする。一部の既存席を省いた部分更新では、指定された既存席も現在の位置を保ち、新規席は更新配列での出現順に末尾へ追加する。既存席の並び替えは、更新前の全席を指定した場合に限る。

素のオブジェクトだけをフィールド単位でマージし、省略したフィールドは現在の値を保持する。この規則は `round_settings` の各ラウンドにも適用する。スカラー、タグ付き共用体、および `seats` 以外の配列は値全体を置き換える。異なる方式の `deadline` を指定すると、旧方式のフィールドは破棄される。

明示的な `null` を受け付けるのは、作成型に `null` が含まれる `chair.display_name` と各ラウンドの `deadline` だけとする。`null` を受け付けないフィールドに指定すると `invalid_argument` を返す。 `shared_materials`、`human_participants`、`round_settings`、`quorum`、`meeting_timeout` への `null` も `invalid_argument` とする。消去できるコレクションには、その型に応じた空の配列または空のオブジェクトを渡す。例えば、`shared_materials` と `human_participants` は `[]` で消去する。フィールド単位でマージする `round_settings` に `{}` を渡した場合は、既存の設定を保持する。

| フィールド | `null` の可否 | 指定時の扱い |
|---|---|---|
| `chair.display_name` | 可 | 表示名を未設定に戻す。 |
| `chair.seat_id` | 不可 | 省略時は現在の値を保持する。 |
| `seats[i].quota` | 不可 | 既存席では省略時に保存値を保持し、既定値を再適用しない。新規席では省略時に接続種別の既定値を保存する。 |
| `round_settings.<round>`（ラウンドエントリ自体） | 不可 | ラウンドエントリを消去できない。 |
| `round_settings.<round>.quorum` | 不可 | 省略時は現在の値を保持する。 |
| `round_settings.<round>.deadline` | 可 | 保存済みの締切を未設定に戻し、通常の締切決定順序を適用する（PROTOCOL.md §4.1）。 |

`council.get_packets` の席入力ビューでは、応答の封筒にパケットとは別に席単位の `notices` 配列を返す。コアは席が `absent` に遷移すると `{ round, seat_id, kind: "absent", reason }` を生成し、その席の有効な席入力ビューの次回の呼び出しで配達する。`notices[].reason` は、欠席遷移時に記録した `reason.code` の文字列とする。コアは受信順序の中で通知の選択と配達済み記録を原子的に行う。配達済みの記録はパケットと同じ `delivery_epoch` の仕組みに従い、応答の送信に失敗しても再配達しない。配達対象の通知がなければ空配列を返す。（PROTOCOL.md §4.1・§4.2）

状態変更系ツールの成功応答は最低限 `{ status: "ok" }` を返し、`status` は文字列 `"ok"` 固定とする。配布・ack・通知の記録を更新する `council.get_packets` の席入力ビューも、この成功応答の共通形に従う。ツール固有の追加フィールドは各ツールの行に列挙する。エラーは共通形式 `{ code, detail? }` で返す。

コアは記録する各時刻について、記録時に同時取得した時計ペア（壁時計値、単調時計値）に基づく壁時計の対応値を併せて保持する。API が返す ISO 8601 値（`opened_at`、`deadline_at` 等）はその保持値から生成し、後の時計ペアで再計算しない。

`round_state` は `{ round, phase: "open" | "frozen", opened_at, deadline_at, quorum }` の JSON オブジェクトとする。 `opened_at` は、ラウンドの開始を記録した時点で保持した壁時計の対応値を返す API 応答フィールドとする。相対締切と当該ラウンドの `OPEN` 期間のタイムアウトの起点には、開始操作の処理時点で取得した内部の開始時刻（単調時計値）を使う（PROTOCOL.md §1.5・§4.1）。`deadline_at` は締切がなければ `null`、`quorum` は未設定なら `null` とする（PROTOCOL.md §1.2）。`round_states` は開始済みラウンドの `round_state` の配列とする。`reception_table` は開始済みラウンドと席の組ごとに1行を持つ JSON 配列とし、各行は `{ seat_id, round, state, reason, current_packet_id, invalidated_packet_id }` とする。 `reason` の型は `{ code: string, text: string | null } | null` とする。`waived` / `absent` では定型コードを `code`、自由文を `text` に保持し、自由文がなければ `text` は `null` とする。理由を持たない状態では `reason` は `null` とする。`current_packet_id`、`invalidated_packet_id` は、それぞれ該当する値がなければ `null` とする。attest 不一致で版を無効化した時点で `current_packet_id` を `null` にし、その版の ID を `invalidated_packet_id` に保持する。（PROTOCOL.md §4）

`"chair"` と `"human"` は予約済みの呼び出し主体識別子とする。コアは、席の `seat_id` にいずれかの値を指定した `council.create_meeting` / `council.update_setup` を `invalid_argument` で拒否する（PROTOCOL.md §4.2a）。

| ツール名 | 引数 | 返り値 | 説明 |
|---|---|---|---|
| `council.create_meeting` | `topic: string, shared_materials?: string[], seats: SeatConfig[], chair: ChairConfig, human_participants?: string[], round_settings?: RoundSettings, quorum?: integer, meeting_timeout?: integer` | `{ status: "ok", meeting_id }` | 認証済み主体が呼び出せる。呼び出し主体を召集者として記録する。会議の人間参加者は、人間の召集者、人間議長、および `create_meeting` または `council.update_setup` の `human_participants` に登録された人間とする。`human_participants` は認証済みの人間 principal の識別子の配列とする。（PROTOCOL.md §8.1）会議作成時に `agenda`（`round: null`）を保存し、会議を `CREATED` とし、整数の `setup_version` を 1 に初期化する。`agenda` の本文は `{ topic: string, shared_materials: string[] }` とする。共通資料は §2.2 の参照IDで指定し、省略時は空配列とする。全参加主体が取得できる。`topic` は必須引数とする。`council.create_meeting` の `chair` は必須引数であり、コアに既定値はない。議長の指定がなければ、呼び出し側（表面・エージェント）が召集エージェントを `chair` に設定して呼び出す。`round_settings` でR2を含む各ラウンドの締切とクォーラムを指定できる。締切とクォーラムの決定規則は §5 に従う。会議作成時に席ごとのクォータも指定できる（`council.get_quota` 行を参照）。 |
| `council.update_setup` | `meeting_id, seats?: SeatUpdate[], shared_materials?: string[], chair?: ChairUpdate, human_participants?: string[], round_settings?: RoundSettingsUpdate, quorum?: integer, meeting_timeout?: integer` | `{ status: "ok", meeting_state }` | `CREATED`（R0開始前）の間だけ、召集者または議長の principal が呼び出せる。議長（`chair`）・登録する人間参加者（`human_participants`、PROTOCOL.md §8.1）・席構成・クォータ（`council.get_quota` 行を参照）・文脈契約・共通資料・ラウンド別設定（`round_settings`）・トップレベルの `quorum`・`meeting_timeout` を更新できる。更新専用スキーマに従って変更する。コアは、保存済みの値も含めて更新後の設定全体を検証する。更新後の設定に無効な値が残る場合は、呼び出し全体を拒否し、変更を部分適用しない。呼び出し側は問題のある設定の修正値を同じ呼び出しで渡す。共通資料を変更した場合、コアは現行の `agenda` の `packet_id` を `supersedes` に指定した新版に差し替える。reopen で継承した設定の変更にも使う。`council.update_setup` が成功するたびに `setup_version` を 1 加算し、旧版の確認記録は失効する（`council.confirm_share` 行を参照）。R0開始時に設定は凍結され、以後の呼び出しはコアが拒否する。 `seats` で席構成と文脈契約を指定し、ID は §2.2 に従って検証する（PROTOCOL.md §1.3・§8.1）。 `invalid_state` の `detail` は `{ meeting_state }`（必要に応じて `round` を追加）。 |
| `council.open_round` | `meeting_id, round: "R0" \| "R1", deadline?: Deadline` | `{ status: "ok", round_state }` | 議長 principal のみが呼び出せる。R0開始時点で人間参加者（人間の召集者・人間議長・`human_participants` に登録された人間）が0人なら、コアは `council.open_round` を拒否する。コアは R0 の開始を会議が `CREATED` の場合に限り受理し、会議設定を凍結して `OPEN(R0)` へ遷移させる。R1 の開始は会議が `GATE(R0)` の場合に限り受理し、`OPEN(R1)` へ遷移させる。コアは `open_round` の操作内でバリアの成立を評価する。必須席ゼロを含め、開始時点で条件を満たす場合はその操作内で凍結し、`round_state` の `phase` に `"frozen"` を返す。会議は R0・R1 の凍結後にそれぞれ `GATE(R0)`・`GATE(R1)` へ進んで議長操作を待ち、R2 の凍結後は `SYNTHESIZING` へ進む（PROTOCOL.md §4.1）。`deadline` 引数はR0・R1の開始時に指定でき、締切は §5 の決定順序に従う。`council.open_round` では、どのラウンドにも `quorum` を指定できない。上書きの `deadline` に当該操作の処理時点（PROTOCOL.md §1.5）ですでに過去の絶対時刻を指定した場合、コアは呼び出しをエラーとして拒否する（§5）。 `invalid_state` の `detail` は `{ meeting_state }`（必要に応じて `round` を追加）。 |
| `council.submit_answer` | `meeting_id, round, seat_id, body, claims?, supersedes?: string \| null` | `{ status: "ok", packet_id, packet_sha }` | 非 Web 席の回答を提出（answer/critique共通）。Web 席の回答は `transcribe_web_seat` 経由でのみ受け付ける。`submit_answer` と `transcribe_web_seat` の呼び出し主体の権限は、対象席の接続種別を問わずに判定する。コアは Web 席を対象とする `submit_answer` を段階 (4) で `invalid_state` として拒否し、操作ログに記録する。Web 席の回答が attest を経ずに `received` に進む経路はない（PROTOCOL.md §8.1）。対象ラウンドが会議の現在の `OPEN` ラウンドでなければ、コアが呼び出しを拒否する。（ラウンド, 席）の初版は、ラウンド締切がある場合は締切以前（同時を含む）にコアが受け付ける必要がある。締切後に初めて届いた提出はコアが拒否する。締切内の初版は、ラウンドが `OPEN` の間は差し替えられる。席が `absent` / `waived` に確定した後、およびラウンド凍結後の提出はすべてコアが拒否する（PROTOCOL.md §4・§4.1）。既存の現行版の差し替えには `supersedes` にその `packet_id` の指定が必須。段階 (2) の版照合は、無効化版を照合先とする例外を含め、`transcribe_web_seat` と同じ規則に従う（PROTOCOL.md §3.4・§4.3）。対象席本人またはその席の認可ドライバかどうかを、接続種別を問わずに判定する。接続種別の不適合は段階 (4) の `invalid_state` とする。受理ごとに当該席のクォータを1消費し、差し替え版もそれぞれ数える。上限を超える提出は共通エラー形式に従って `invalid_state` で拒否する（PROTOCOL.md §9）。 `invalid_state` の `detail` には `{ reception_state, round_frozen, deadline_eligible }` を含め、クォータ超過時は `quota_exceeded: true` も含める。当該ラウンド・席に現行版も照合対象の無効化版も存在しない初回に限り、非 `null` の `supersedes` の指定自体を段階 (2) で `invalid_argument` として拒否する（PROTOCOL.md §3.4・§4.3）。 |
| `council.submit_flash` | `meeting_id, round, seat_id, body, basis` | `{ status: "ok", packet_id, packet_sha }` | 議長、`flash: true` が設定された席本人、またはその席の認可ドライバのみが速報を提出できる。速報担当席として呼ぶ場合は `seat_id` 引数に当該席の `seat_id` を渡し、議長として呼ぶ場合は `"chair"` を渡す。議長として提出したパケットの `seat_id` 欄には `"chair"` が入り、著者は議長ロールとなる。対象ラウンドが会議の現在の `OPEN` ラウンドでなければ、コアが呼び出しを拒否する。コアは `absent` / `waived` に確定した席の `seat_id` での速報を拒否する。議長ロールの速報（`seat_id: "chair"`）は、兼務する議長自身の席の状態にかかわらず、対象ラウンドが会議の現在の `OPEN` ラウンドである間は提出できる。 この検証を前提に、内容規範と配布保留の条件は対象ラウンドを基準に適用する。バリア成立前に他席の当該ラウンド回答を引用・要約した `flash` を書いてはならない。共有規則に従い、凍結済み回答に含まれない席固有資料を速報に混ぜてはならない。当該ラウンドの他席回答を読む権限を持つ principal（そのラウンドに参加していない議長等）が `OPEN` 中に提出した `flash` は、参加席への配布をバリア成立まで保留し、成立後に配布する。参加席自身の `flash` は即時に配布対象とする（PROTOCOL.md §5）。席としての提出は受理ごとに当該席のクォータを1消費する。議長ロールの速報は席の消費に含めない。上限を超える提出は共通エラー形式に従って `invalid_state` で拒否する（PROTOCOL.md §9）。 `invalid_state` の `detail` には `{ reception_state, round_frozen }` を含め、クォータ超過時は `quota_exceeded: true` も含める。 |
| `council.transcribe_web_seat` | `meeting_id, round, seat_id, body, supersedes?: string \| null` | `{ status: "ok", packet_id, packet_sha, attest_required: true }` | Web 席の手渡し転記。当該会議の召集者 principal（運用者）、対象席にひも付く認証済み principal（席本人）、またはその席の認可ドライバのみが呼び出せる。コアは他の参加者からの呼び出しを拒否する。対象席の接続種別の適格性は段階 (4) で判定し、非 Web 席への転記は `invalid_state` で拒否する。`detail` には `{ reception_state, round_frozen, deadline_eligible }` を含める。検査順と監査分類は PROTOCOL.md §4.3 に従う。対象ラウンドが会議の現在の `OPEN` ラウンドでなければ、コアが呼び出しを拒否する。初回転記では、ラウンド締切がある場合は受信時刻が締切以前（同時を含む）なら締切適格性があるとし、処理が締切後でもその判定は変わらない。転記で受信時刻を用いるのは初回に限る。現行版または無効化版の差し替えは、接続種別を問わず PROTOCOL.md §4.1 の継承規則に従い、初版の締切適格性を継承する。ラウンドと席の状態は全体順序で当該操作を処理する位置で検査する。席が `absent` / `waived` に確定した後、およびラウンド凍結後の提出はすべてコアが拒否する。他の必須席が未確定でラウンドが `OPEN` のままでも、対象席が `absent` なら再転記は拒否される（PROTOCOL.md §4・§4.1・§4.3）。状態に基づく拒否では、本節の共通エラー形式に従い `detail` を返し、監査ログに同じ事実を記録する。attest 未確定の状態で登録する。締切スイープ前に attest 不一致で無効化された版は、ラウンドが `OPEN` で、再転記が締切条件を満たす場合に差し替えられる。段階 (2) では、当該ラウンド・席に現行版があれば `supersedes` はその `packet_id` と一致しなければならない。attest 不一致で現行版がなく無効化版が照合対象となる場合は、`supersedes` は受領表の `invalidated_packet_id` と一致しなければならない。照合対象の版がある場合の省略・`null`・不一致は `invalid_argument` とする（PROTOCOL.md §3.4・§4.3）。転記の受理時に当該席のクォータを1消費し、差し替え版もそれぞれ数える。上限を超える提出は共通エラー形式に従って `invalid_state` で拒否する（PROTOCOL.md §9）。 `invalid_state` の `detail` には `{ reception_state, round_frozen, deadline_eligible }` を含め、クォータ超過時は `quota_exceeded: true` も含める。当該ラウンド・席に現行版も照合対象の無効化版も存在しない初回に限り、非 `null` の `supersedes` の指定自体を段階 (2) で `invalid_argument` として拒否する（PROTOCOL.md §3.4・§4.3）。 |
| `council.submit_attest` | `meeting_id, target_packet_id, method, result, evidence` | `{ status: "ok", verified_result: "confirmed"\|"mismatch" }` | **v1 注記**。v1 のコアは `verbatim_confirm` のみを受理する。`method=hash_match` の `submit_attest` は、v1 の許容値の範囲外として段階 (0) で `invalid_argument` を返す。Web 席の転記内容は、原文との一致・不一致の申告によって確認する。以下の `hash_match` の規則は後継版に適用する。`verbatim_confirm` の `evidence` は `{ method, confirmer, target_packet_id }`、`hash_match` の `evidence` は `{ method, confirmer, target_packet_id, source_hash }` とする。両方式で `method` は方式名、`confirmer` は空でない文字列、`target_packet_id` は文字列とし、いずれも必須とする。`hash_match` の `source_hash` は必須で、64文字の小文字16進数とする。 引数の `method` と `evidence.method` は一致を必須とする。不一致は手順0で `invalid_argument` とし、一致した `method` のスキーマで `evidence` を検証する。コアは両方式で本節の共通検査順を適用する。手順0では、`evidence` の入れ子項目を含むすべての引数の形式（型、必須項目、許容値、書式）を認可より先に検査し、`verbatim_confirm` への `source_hash` の指定、定義外の追加フィールド、必須文字列への `null` を含め、違反があれば `invalid_argument` を返す。`evidence.target_packet_id` が引数の `target_packet_id` と異なる場合も、引数間の整合に関する形式違反として手順0で `invalid_argument` を返す。手順0を通過した後、(a) 呼び出し主体が当該会議の召集者、または当該会議のいずれかの Web 席の `principal`・認可ドライバでなければ `unauthorized` を返す。`evidence.confirmer` が認証済みの呼び出し主体の識別子と異なる場合も、手順 (a) の検索前認可で `unauthorized` を返す。(b) この確認を通過した呼び出しで、`target_packet_id` に指定した `packet_id` が当該会議で未知なら `not_found` を返す。(c) 対象パケットが当該会議の Web 席にひも付かない場合（席なし種別など）は、認可対象の席が存在しないため `unauthorized` を返す。対象 Web 席が存在する場合、呼び出し主体が当該会議の召集者、対象 Web 席の `principal`、または対象 Web 席の `driver_principals` に含まれる認可ドライバのいずれにも該当しなければ `unauthorized` を返す（PROTOCOL.md §8.1）。後継版の `hash_match` では、認可完了後、段階 (2) で検索を要する証拠の引数検証を行う。(d) 認可済みの Web 席でも、対象がその席のattest 未確定の現行転記版でない場合（`flash`、差し替え済みの版、判定確定済みの版、席が `transcribed_pending_attest` でない場合など）や、ラウンドが凍結済みの場合は `invalid_state` を返す。ラウンドが凍結されておらず、対象がその席の有効な現行転記版で、判定が未確定かつ席の受領状態が `transcribed_pending_attest` の場合に限り、判定の確定に進む。`verbatim_confirm` では、手続きが適正であれば認可された確認者の申告 `result`（`confirmed` / `mismatch`）そのものを確定結果とする。`hash_match` では、コアが `body_sha` と `evidence.source_hash` を照合し、一致なら `confirmed`、不一致なら `mismatch` と確定する。呼び出し元の `result` は参考情報として記録する。両方式とも申告 `result` は必須引数とし、コアの確定結果と異なる場合も、申告値をそのまま attest パケットの `body.result` に保存する。attest 本文は入力値からなる固定形の JSON オブジェクトとし、`verbatim_confirm` は `{ method, result }`、後継版の `hash_match` は `{ method, result, source_hash }` とする（PROTOCOL.md §3.2）。コアは対象 `packet_id` にひも付けて、attest パケットの ID、計算した `body_sha`、確定結果、確定した全体順序上の位置を保持する。申告はパケット本文から、確定結果はコア側の記録から復元できる。監督ビューでは対象パケットの `packet_state.verification` に対応する検証状態を提示する（PROTOCOL.md §3.2・§4.3）。API 応答の `verified_result` にはコアの確定結果を返す。版に対する判定（`confirmed` / `mismatch`）は、最初に手続き適正に確定した時点で終局となる。確定済みの版への後続の attest はすべて拒否し、`confirmed` の版は `received`、`mismatch` の版は `invalidated` のままとする。締切スイープは `transcribed_pending_attest` の席を `absent` にしない。`confirmed` なら席は `received` となる。`mismatch` の確定がスイープ前なら席は `pending` に戻り、スイープ後なら確定時に attest 不一致を理由に `absent` となり、再転記は拒否される。差し替えが許される場合は新版の attest が必要となる。未認証、権限外、手続き不備、判定確定済み、対象席が `transcribed_pending_attest` 以外（`absent` / `waived` / `received` に確定している場合は締切の有無や時刻を問わない）、ラウンド凍結後、または対象が有効な現行版以外（不一致で無効化された版を含む）の場合は、結果を確定せずエラーとして拒否する。attest パケットは作らず、拒否を会議の操作ログに記録する（PROTOCOL.md §4.3・§8.1）。 `invalid_state` の `detail` は `{ target_reception_state, round_frozen }`。 |
| `council.get_state` | `meeting_id` | `{ meeting_state, round_states, reception_table, timeout_exceeded, reopens, seats: SeatEntry[], setup_version }` | 当該会議の席本人・席の認可ドライバ・召集者・議長・人間参加者が会議の現在状態を取得できる。召集者は自分が召集した会議の監督読み取りができる。席の認可ドライバが呼び出す場合は、担当席について席本人と同じ席入力ビューを受ける。当該会議のどの席の認可ドライバでもなく、会議内の他の認可された役割も持たない呼び出し主体には `unauthorized` を返す。`seats` は現行設定の `seats` 配列と同じ順序で席エントリを返す。各 `SeatEntry` は文字列の `seat_id` フィールドと、その席の文脈契約のフィールドを持つ。各エントリに資料一覧と件数の出し分けを適用し、同じ整合スナップショットの整数の `setup_version` と一体で返す。`council.get_state` は各席の `seat_specific_materials` の項目一覧を当該席本人・その席の認可ドライバ・議長・当該会議の人間参加者にのみ返す。各項目には `id` と当該席の `sharing_policy` を含める。一覧を返す場合、文脈契約の `seat_specific_materials_count` は省略する。一覧の閲覧権限がない呼び出し主体には、文脈契約に整数の `seat_specific_materials_count` を載せ、`seat_specific_materials` は省略する。席固有資料の項目内容はコアの外にある。コアは `get_state` / `get_packets` の応答で席固有資料の項目内容そのものを返さない。議長は `cite_in_synthesis` の確認に基づき、統合本文で資料を引用できる（PROTOCOL.md §6）。表面は `council.get_state` と `council.get_packets` のいずれについても、資料とその応答の `setup_version` を一体で保持し、資料を再表示するまで確認に使う版を更新してはならない。受領表 `reception_table`、`timeout_exceeded` フラグ、`reopens`（再開元会議 ID、なければ `null`）を含む。R0・R1のバリア成立後はそれぞれ `GATE(R0)`・`GATE(R1)` に入り、議長の次の操作を待つ。R2のバリア成立後は直接 `SYNTHESIZING` へ進む（PROTOCOL.md §1.2）。コアが判定・設定した `timeout_exceeded` をこの応答で返し、表面はそのフラグに基づいて会議スレッド内にシステム表示する（PROTOCOL.md §1.5、本書 §4）。 |
| `council.get_packets` | `meeting_id, caller_seat_id, round?, ack_packet_ids?, delivery_epoch?, view?: "input" \| "oversight"` | input: `{ status: "ok", new_packets, superseded, setup_version, delivery_epoch, notices }`<br>oversight: `{ new_packets, superseded, setup_version }` | 当該会議の席・議長・人間参加者、および自分が召集した会議を監督ビューで読む召集者が呼び出せる。配布・ack・差し替え情報は `packet_id` を主キーとし、`superseded` の各要素は `{ old_packet_id, new_packet_id }` とする。同一の `packet_sha` を持つパケットも別々に配布・ack する。`council.get_packets` はビューにかかわらず `setup_version` を返す。`council.get_packets` と `council.get_state` では、各応答は会議状態の単一の整合スナップショットから計算する。応答の `setup_version` はそのスナップショットの設定版であり、パケット選択と `packet_state` も同じスナップショットに基づく。旧いパケット集合と新しい `setup_version` が一つの応答に混在することはない。表面は `council.get_state` と `council.get_packets` のいずれについても、資料とその応答の `setup_version` を一体で保持し、資料を再表示するまで確認に使う版を更新してはならない。`council.confirm_share` には、表示した資料を含む応答の `setup_version` を渡す。会議参加主体は、会議作成直後から `agenda`（`round: null`）を、ゲート判定の確定後に `gate_decision`（`round: "R1"`）を、生成後に `synthesis`（`round: null`）を取得できる。`note`（`round: null`）は投稿後、配布保留と監督ビューの認可の範囲内で取得できる。`note` の席への配布には速報と同じ PROTOCOL.md §5 の保留規則を適用する。`round` 指定時はそのラウンドの認可済みパケットを返し、省略時は認可範囲の全ラウンド分に認可済みの会議レベルのパケットを加えて返す。`view` の既定値は `"input"`。席のひも付けがない当該会議の召集者・議長・人間参加者は、`view: "oversight"` を明示し、`caller_seat_id` に議長としては `"chair"`、人間参加者としては `"human"`、召集者としては `"convener"` を指定する。コアは指定されたロールを認証済み principal と照合する。配布と ack の単位となる席がないため、コアは席のひも付けがない principal の `input` 呼び出し（`view` 省略時を含む）を拒否する。議長が `input` を使う場合は、本人または認可ドライバとしてひも付く当該会議の席の `seat_id` を `caller_seat_id` に指定する。**席入力ビュー（`"input"`）**では現時点の認可範囲内の未 ack のパケットを `seq` 順に返し、`new_packets` の各要素は応答上のパケットオブジェクトとする。席入力ビューで配布する `agenda` は現行版に限る。他席の `answer` / `critique` は対象ラウンドの凍結スナップショットに含まれる `received` の現行版のみを返す。バリア成立前の取得範囲は、自席のパケット、配布保留されていない `flash` / `note`、`agenda`、取得可能になった `gate_decision` / `synthesis`、および役割に応じて認可されるその他のシステム系パケットに限る。他席のR0回答はR1開始以降に配布する。**監督ビュー（`"oversight"`）**では、ラウンドに属するパケットの監督ビューでの取得は、当該会議の召集者 principal・議長 principal・人間参加者に認可する。召集者は、自分が召集した会議で対象転記版の配布資格にかかわらず常に attest の配布対象となり、監督ビューで取得する。取得には通常のラウンド認可を適用する。バリア成立前は対象ラウンドの参加席を兼ねない principal に限り、成立後は参加席を兼ねる principal にも認可する。対象ラウンドの参加席の兼務は、その席の `principal` または `driver_principals` と呼び出し主体の認証済み principal を照合して判定する。`ChairConfig.seat_id` の指定の有無にかかわらず判定し、他席の現行ラウンド回答に対するバリア前の監督ビューの閲覧制限は、本人として保持する席および代理できる席ごとに適用する。明示した `round` について監督ビューの認可がない場合はエラーとする。`round` を省略した場合は認可されていないラウンドを応答から除外する。保留中の `note` と差し替え済みの `agenda` を除き、会議レベルのパケットの監督ビューでの取得認可は、会議参加主体であれば足りる。認可ドライバが監督ビューを使えるのは、その principal が独立に当該会議の召集者・議長・人間参加者のいずれかのロールを持ち、そのロールで監督ビューの認可条件を満たす場合に限る。コアは保留中の `note` に投稿時ラウンド（発生ラウンド）をひも付ける。そのバリアが成立するまでは、監督ビューでも発生ラウンドのバリア前回答と同じ取得制限を適用し、会議内で席ロールを持つ主体（席本人または認可ドライバとして席を兼務する召集者・議長・人間参加者）には返さない。バリア成立後は通常の会議レベルのパケット（`round: null`）として全参加主体に取得を認可する。兼務議長は認可に応じて呼び出しごとにビューを選べる。監督ビューは閲覧用であり、ack を使わず、配布済み集合を持たない。上記のラウンド条件と現時点の認可範囲に該当する全件（現行版・旧版・未検証版を含む）を毎回 `seq` 順に返す。会議レベルのパケットを取得する場合も、差し替え済みの `agenda` を返すのは、`oversight` の認可を持つ当該会議の召集者・議長・人間参加者が監督ビューで取得する場合に限る。`oversight` の認可を持たない席には、会議レベル取得でも現行の `agenda` のみを返す。監督ビューでは認可された `agenda` の全版を `packet_state` つきで返す。確認の対象は現行設定の資料に限る。差し替えられた旧 `agenda` の内容に基づく共有確認はできない。検証状態が変われば、次回の取得で新しい状態が見える。`new_packets` の各要素は `{ packet, packet_state, missing_records, declared_missing_records }` とし、`packet` に応答上のパケットオブジェクト、`packet_state` に取得時点の状態を下記の割り当て表に従って格納する。`missing_records` は、凍結済み受領版についてのみ保存するコア検出の構造化提出の欠落を格納する文字列の配列（`string[]`）とする。対象が凍結済み受領版でない場合や、該当する欠落がない場合は空配列を返す。同じパケット版について、統合で受理された議長の欠落申告を `declared_missing_records`（`{ seat_id, packet_id, note }` の配列）として、コア検出の `missing_records` と並べて返す。出所はフィールドで区別し、申告がなければ空配列を返す。監督ビューで得た内容は席入力として使わない。空でない `ack_packet_ids` を指定した場合に限り、`delivery_epoch` は必須とする。ack を送らない通常の取得では `delivery_epoch` を省略できる。席入力ビューでは、空でない `ack_packet_ids` を指定した場合に限り、コアは `delivery_epoch` の省略を理由に呼び出し全体を契約エラー（`invalid_argument`）として拒否する。`view: "oversight"` に `ack_packet_ids` と `delivery_epoch` のいずれかを渡した場合も、コアは呼び出し全体を `invalid_argument` として拒否する。未知の `packet_id` の ack または現行世代と一致しない ack の無視と監査ログへの記録は、契約と認可の条件を満たす席入力ビューの呼び出しでのみ適用する。席入力ビューの配布応答には、同じ整合スナップショットの当該席の現行 `delivery_epoch` を含める。呼び出し主体は配布応答の `delivery_epoch` を `ack_packet_ids` とともに渡す。コアは現行世代の値を伴う ack のみを受理対象とする。`delivery_epoch` が当該席の現行世代と異なる場合は、古い世代でも未来の世代でも ack 部分だけを無視し、監査ログに記録して、パケット取得を続ける。席への配布と ack は席単位とする。認可された席本人またはドライバのいずれかに返却した時点で、その席に配布済みとする。その席について認可された主体のいずれからでも、その席に配布済みで現時点の認可範囲内にあるパケットを ack できる。配布世代 `delivery_epoch` は会議と `seat_id` の組ごとに会議の存続中は単調に増加し、値を再利用しない。未使用の `seat_id` の初期値は 1 とする。`council.update_setup` で席の `principal` または `driver_principals` の集合が変わった場合、その席の配布世代 `delivery_epoch` を増やし、配布済み・ack 済みの記録を消去し、全パケットを未配布に戻す。旧主体による ack は無効となり、更新後に認可された主体に現行設定と取得時の認可範囲に従って再配布する。未知・認可外・未返却の `packet_id` はエラーにせず無視し、冪等な再試行を許す。未 ack のパケットは次回も認可範囲と `round` の条件を満たせば再返却する。R1開始時のR0受領分にも同じ方式を適用する。差し替え情報も同じ認可範囲でフィルタする。召集者として読む場合は `view: "oversight"` と `caller_seat_id: "convener"` を指定する。コアはこの組み合わせで `"convener"` をロール指定として解釈し、認証済み principal が当該会議の召集者と一致することを確認する。必須の `caller_seat_id` には、席として呼ぶ場合は自席または代理する席の `seat_id`、議長として呼ぶ場合は予約値 `"chair"`、人間として呼ぶ場合は予約値 `"human"` を渡す。接続トークンまたはセッションにひも付く認証済み principal の会議内の席またはロールと照合する。席を指定した場合、呼び出し主体の認証済み principal が当該席の `principal` と一致するか、当該席の `driver_principals` に含まれる場合に限り照合を通す。不一致はエラーとする。`input`（`view` 省略時を含む）では、呼び出し主体の認証済み principal に本人または認可ドライバとしてひも付く、当該会議に実在する席の `seat_id` を `caller_seat_id` に指定しなければならない。コアは `input` で予約値 `"chair"` / `"human"` を拒否する。これらの予約値は、それぞれの認可条件に従い、`oversight` および議長ロール操作でのみ有効とする。認可ドライバは担当席と同じ権限で席入力ビューから取得し、担当席の配布先として ack できる（PROTOCOL.md §4.2・§4.2a）。 |
| `council.declare_absent` | `meeting_id, round, seat_id` | `{ status: "ok" }` | 議長 principal のみが呼び出せる欠席宣言。対象ラウンドが `OPEN` で、対象席が `pending` または `transcribed_pending_attest` の場合にだけ受理し、対象席を `absent` に遷移させ、PROTOCOL.md §4 に従って当該ラウンドの履歴に基づく欠席理由を記録する。対象ラウンドが `OPEN` でない場合や、対象席がすでに `received` / `waived` / `absent` の場合は拒否する。他の状態変更操作と同じコア受信順序の規則に従う（PROTOCOL.md §1.5・§4）。 `invalid_state` の `detail` は `{ reception_state, round_frozen }`。 |
| `council.waive_seat` | `meeting_id, round, seat_id, reason_code, reason_note?` | `{ status: "ok" }` | 議長による免除宣言。コアは、対象ラウンドが現在の `OPEN` ラウンドで、対象席が `pending` または `transcribed_pending_attest` の場合にだけ `waive_seat` を受理する。受領済み（`received`）の席や、凍結済みラウンドの席への呼び出しは拒否する。免除は当該ラウンドに限り有効とする。 `reason_code` は定型コード（`seat_unavailable`/`quota_exceeded`/`duplicate_coverage`/`chair_judgment`/`other`、PROTOCOL.md §4.1a）。 `invalid_state` の `detail` は `{ reception_state, round_frozen }`。 |
| `council.chair_gate` | `meeting_id, result: "pass"\|"fail", resolved_points?, unresolved_points?（fail 時は必須（非空））, next_round_scope?（fail 時は必須（非空））, r2_deadline?: Deadline, rationale?: string` | `{ status: "ok", gate_decision_packet }` | 議長のみが呼べる（roundは常にR1固定のため引数から省略）。コアは会議が `GATE(R1)` の間だけ `chair_gate` を受理する。判定を `gate_decision` として記録すると同時に、Pass なら `SYNTHESIZING` に遷移し、Fail なら `OPEN(R2)` に遷移する。遷移後の再呼び出しは、会議が `GATE(R1)` ではないため拒否する。判定理由は `gate_decision` 本文の必須フィールド `rationale` に格納し、引数を省略した場合は空文字列を入れる。`resolved_points`、`unresolved_points`、`next_round_scope` は本文に常に含める。コアは省略された配列引数を空配列 `[]` として格納し、キーを省略しない。コアは `result: "pass"` と `r2_deadline` の同時指定を `invalid_argument` として拒否する。コアは Fail 時に `unresolved_points` と `next_round_scope` の両方が非空でなければ呼び出しを拒否する。Fail 時の `r2_deadline` は絶対時刻・相対時間の両形を受け付ける。相対時間はR2開始時刻に再アンカーし、当該操作の処理時点（PROTOCOL.md §1.5）ですでに過去の絶対時刻を指定した呼び出しはコアがエラーとして拒否する。R2の締切の決定順序は §5 に従う。Fail 判定そのものが `OPEN(R2)` への遷移となり、`gate_decision` パケットの `next_round_scope` が対象論点を指定する。別途 `open_round` を呼ぶ必要はない。 `invalid_state` の `detail` は `{ meeting_state }`（必要に応じて `round` を追加）。 |
| `council.synthesize` | `meeting_id, body` | `{ status: "ok", synthesis_packet }` | 議長の種別にかかわらず、`body` は必須とし、省略した呼び出しはコアが拒否する。統合本文は議長エージェント自身、または人間議長の側で用意する。人間議長がエージェントの下書きを使う場合は、コアの外で得た本文を `body` として渡す。コアは統合本文を生成しない。議長は `body` に `agreements`、`minority_opinions`、`unverified_items`（未検証回答への参照の配列。各要素は `{ seat_id, packet_id }` で両値は文字列）、`missing_records`（自然文の欠落申告の配列。各要素は `{ seat_id, packet_id, note }` で各値は文字列）、`reversal_conditions`、`recommendation`、`cited_materials` を渡す。入力の `unverified_items` と `missing_records` はいずれも任意であり、それぞれの省略は「申告なし」（空配列）と同じ意味とする。コアは必須配列の `agreements`、`minority_opinions`、`reversal_conditions` と、`cited_materials` を検証する。コアは、入力の `unverified_items` と `missing_records` のいずれかに配列以外の値（`null` やオブジェクトを含む）が指定された場合、呼び出しレベルの型エラーとして `synthesize` 全体を拒否する。要素単位の破棄は、配列として渡された `unverified_items` と `missing_records` に限る。コアは型や参照先に不備のある要素を個別に破棄し、監査ログに記録して統合処理を続ける。`cited_materials` に不備がある場合は、PROTOCOL.md §6 の引用の拒否契約に従い、統合全体を拒否する。保存する `unverified_items` の全要素は `seat_id`、`packet_id`、`state`、`source` を持つオブジェクトとし、文字列だけの要素は存在しない。コアは議長が渡した未検証回答への参照に `source: "chair"`、コア生成の欠落記録に `source: "core"` を設定する。コアは欠落のある凍結済み受領版につき1つの要素を保存し、欠落したフィールド名を文字列配列 `missing` に格納する。`missing` には、欠落した構造化提出のスキーマに定義されたフィールド名をそのまま使い、版ごとに重複なく（集合として）記録する。欠落の判定は PROTOCOL.md §3.3 に従う。v1 では主張ごとの粒度は記録しない。（PROTOCOL.md §3.3・§6）議長申告の要素には `missing` を付けない。議長が申告した欠落の内容は `declared_missing_records` の `note` に保存する。コアは `unverified_items` の各要素について、`packet_id` が当該会議・当該 `seat_id` のパケットを指すことを照合する。コア生成の欠落記録は、検出された提出版の `packet_id` と `seat_id` を保持し、その値で照合する。参照を解決できない要素は破棄し、監査ログに記録する。議長が申告した未検証回答への参照は、参照先の版の `kind` が `answer` または `critique` で、かつ `packet_state.verification` が `unverified`（attest 未確定・不一致を含む）の場合に限り保存する。検証済みの回答、`flash` など条件外の参照は破棄し、監査ログに記録する。この条件を満たせば、差し替え済みの版も参照できる。コアは入力要素に `state` があっても無視し、保存時に受領記録から `state` を補う。議長は `reception_summary` を渡さない。コアは受領表からこれを計算し、渡された値があってもコアの計算値で置き換える。保存する `synthesis` の `body` は、議長の `agreements`、`minority_opinions`、`reversal_conditions`、`recommendation`、`cited_materials`、統合後の `unverified_items`、`declared_missing_records`、コアが計算した `reception_summary` で構成する。構造化フィールドを持つ提出は、`claims` が空配列でも構造化提出として扱う。コアは `claims` が空配列の場合や、`statement` または `reversal_condition` が PROTOCOL.md §3.3 の判定（空白の定義は §3.2）で欠落した主張がある場合に、欠落を機械的に検出し、凍結済み受領版について、その版にひも付けて記録する。自然文経路は構造化フィールドが一切ない提出にのみ適用する。自然文のみの回答では、議長が統合作成時に読み取り、欠落があれば、対象版を `packet_id` で特定する `{ seat_id, packet_id, note }`（各値は文字列）の形で、提出する `missing_records` に含める。コアは、議長が申告した欠落記録について、`packet_id` が当該ラウンドの `seat_id` に対応する凍結済み受領版を指すこと、およびその受領版が構造化フィールドを一切持たない自然文の提出であることを検証し、両方を満たす有効な記録だけを `{ seat_id, packet_id, note }` の形で統合の `declared_missing_records` に保存する。凍結された受領版に一致しない申告や、構造化提出を対象とする申告は破棄し、監査ログに記録する。構造化提出ではコアの機械的な欠落記録を優先する。コア生成の欠落記録は、バリア凍結時点の現行版のうち、凍結済み受領版についてのみ保存する。これにより、統合に入る欠落記録をバリア凍結時点の現行版に限る規則が、自然文由来の記録にも機械的に適用される。構造化提出の欠落記録はコア生成と分かる形で記録する。差し替え済みの旧版の欠落記録は保存しない。議長が宣言しなかった自然文の欠落は記録されず、その判定と宣言は議長の責任とする。（PROTOCOL.md §3.3）`unverified_items` の空配列は「記録された未検証事項なし」を意味する。自然文の未宣言の欠落がないことまでは保証しない。表面はこの空配列を「記録なし」と表示する。（PROTOCOL.md §6）議長は統合本文が依拠するすべての席固有資料と、証拠として引用するすべてのパケットを `cited_materials` に宣言しなければならない。パケットにも資料と同じ宣言規則を適用し、`packet:` 参照を用いる。各要素は `{ material_ref: string }` とし、引用がなければ空配列とする。統合の引用認可では、`seat:<seat_id>:<item_id>` 形式の参照に限って、参照先の席の `sharing_policy` を照合する。`packet:<packet_id>` 形式は、凍結済み回答など既に会議の配布規則の対象である当該会議内のパケットを指す。`packet:` 参照で引用できるのは、凍結された受領版の `answer` / `critique`、現行版（差し替えられていない版）の `agenda`、`gate_decision` に限り、共有確認は不要とする。差し替え済みの `agenda` は、`oversight` の認可を持つ当該会議の召集者・議長・人間参加者が監督ビューで閲覧できる。議長の申告上の義務として、統合本文で引用・転載・言及できる議題は現行の `agenda` に限る。議長は差し替え済みの `agenda` の内容を統合本文で引用・転載・言及してはならない。機械的検証は `cited_materials` の参照チェックで行う。`flash`、差し替え済みの `agenda`・回答版（`answer` / `critique`）、未検証の版は引用できない。議長が速報の内容を自分の言葉で述べ直したものは、議長自身の暫定の記述として扱う。速報の引用には当たらず、速報を `cited_materials` に宣言しない。統合本文では、議長自身の記述であり、暫定・未検証であることが分かるように示す。速報の内容を席の証拠として扱う場合は、その席のバリアで確定した本答を用いる。`no_share` は確認記録があっても引用不可とし、`share_with_confirmation` は当該会議で `material_ref` と用途 `cite_in_synthesis` が一致し、`setup_version` が会議の現在の値と一致する確認記録がある場合に限り引用を認める。`share_with_seat` は引用不可とする（統合は席ではない）。`share_freely` は確認記録なしで引用を認める。コアは段階 (3) で `cited_materials` の資料参照とパケット参照を解決し、存在しない参照があれば段階 (4) に先立って `not_found` を返す。段階 (4) で引用不可の資料参照またはパケット参照が1つでもあれば、統合全体を `invalid_state` として拒否する。`detail` は `{ meeting_state, offending_materials }` とし、`offending_materials` は参照文字列の配列（`string[]`）とする。抵触した参照は、提出された `material_ref` の文字列のまま、それぞれ1回だけ `cited_materials` における初出順に並べる。会議状態も不適合であれば、段階 (4) で該当する判定事実をすべて `detail` に含める。（PROTOCOL.md §6）会議状態のみが不適合の場合の `detail` は `{ meeting_state }`（必要に応じて `round` を追加）。 |
| `council.approve` | `meeting_id, decision: "approve"\|"reject"\|"reopen", reopen_points?: string[]` | `{ status: "ok", meeting_state }`（approve/reject時） または `{ status: "ok", meeting_state, new_meeting_id }`（reopen時） | 承認・却下・reopen は当該会議の人間参加者のみが `AWAITING_APPROVAL` で実行できる。コアは非参加の人間からの呼び出しを拒否する。決定は状態遷移により一度だけ効力を持ち、`AWAITING_APPROVAL` を抜けた後の `approve` は拒否する。`decision: "reopen"` の場合、`reopen_points` は必須かつ非空の文字列配列とし、省略または空配列での呼び出しはコアが拒否する。`reopen` は却下と新会議作成の一括操作。元会議を理由 `reopened` で `REJECTED` に確定し、`reopens: meeting_id` を持つ新会議を作成する。新会議の召集者は reopen を実行した人間（`council.approve` の呼び出し主体）とする。新会議は `CREATED`、`setup_version: 1` で作成し、元会議の議長・`human_participants`・席構成・文脈契約・共通資料を既定で継承する。元会議の各席のクォータ（`quota`）とラウンド別設定（`round_settings`）・トップレベルの `quorum`・`meeting_timeout` の設定値を継承する。評価済みの時刻は引き継がず、相対締切は§5 の締切の決定順序に従って新会議の該当ラウンドの開始時刻に再アンカーする。召集者または議長の principal は `CREATED` の間に `council.update_setup` で継承した設定を変更できる。新会議の `agenda.topic` は `reopen_points` の要素を順に「 / 」で連結した文字列とする。`reopen_points` には、元会議の最終 `gate_decision` の `unresolved_points` から選んだ文字列をそのまま、`synthesis` の `minority_opinions` から選んだ意見はその本文文字列を、自由入力は入力した文字列を渡す。これらは混在できる。（PROTOCOL.md §1.4） `invalid_state` の `detail` には少なくとも `meeting_state` を含める。 |
| `council.get_quota` | `meeting_id, seat_id` | `{ used, limit }` | 当該会議の参加主体（席・議長・人間）のみがクォータ消費状況を確認できる。クォータは席ごと・会議単位の提出受理件数の上限とする。Web 席（手渡し）は既定値4、最大6とし、CLI・API・ローカル席は既定値10、最大20とする。設定と検証は §3 の `SeatConfig.quota` に従う。この呼び出しは助言的な事前確認であり、強制点はコアの提出受理判定とする（PROTOCOL.md §9）。 |
| `council.post_message` | `meeting_id, body: { text: string }` | `{ status: "ok", packet_id, packet_sha }` | 当該会議の人間参加者と議長は、本文 `{ text }` を渡して `council.post_message` で `note` を投稿できる。`note` を投稿できるのは会議が `CREATED`・`OPEN`・`GATE(round)`・`SYNTHESIZING`・`AWAITING_APPROVAL` の間に限る。コアは `APPROVED`・`REJECTED` での投稿を拒否する。reopen の場合は新会議に投稿する。`get_packets` では会議レベルのパケット（`round: null`）として取得できる。`note` にも速報と同じ内容規範を適用し、バリア成立前に他席の当該ラウンド回答を引用・要約してはならない。当該ラウンドの他席回答をバリア前に閲覧できる主体（議長や監督ビューの人間）が `OPEN` 中に投稿した `note` は、速報と同じ仕組みでバリア成立まで席への配布を保留し、成立後に配布する。共有規則に従い、凍結済み回答に含まれない席固有資料を `note` に混ぜてはならない。用途は議長への指示・補足に限る軽量な経路とし、チャットシステムにはしない。（PROTOCOL.md §3・§4.2a・§8.1） `invalid_state` の `detail` には少なくとも `meeting_state` を含める。 |
| `council.confirm_share` | `meeting_id, material_ref, setup_version: integer, purpose: "share_with_seat" \| "share_external" \| "cite_in_synthesis", to_seat_id?` | `{ status: "ok" }` | 当該会議の参加者である人間 principal（PROTOCOL.md §8.1 の人間参加者の定義に従う）のみが呼び出せる。会議の参加者でない人間からの呼び出しはコアが拒否する。表示した資料を含む応答の整数の `setup_version` を必須引数とする。コアは資料・宛先席の参照を解決する前に `setup_version` を会議の現在値と照合する。版が一致しない場合は、資料が現行設定に存在するかどうかにかかわらず、コアは `invalid_state` を返し、`detail` は `{ meeting_state, expected_setup_version, provided_setup_version }` とする。 `expected_setup_version` には処理位置での現在の版、`provided_setup_version` には引数で指定された版を入れる。版が一致した場合にだけ資料参照を現行設定に対して解決し、参照先が現行設定に存在しなければ `not_found` を返す。用途が `share_with_seat` の場合に、指定された宛先席（`to_seat_id`）が現行設定に存在しない場合は、設定版の一致と資料参照の解決の後に、段階 (3) で `not_found` を返す。段階 (4) で共有ポリシーを判定し、`no_share` の場合は `invalid_state` を返す。`share_with_seat` ポリシーでは、用途が `cite_in_synthesis` または `share_external` の場合、および用途が `share_with_seat` で現行設定に存在する `to_seat_id` が `seat_ids` に含まれない場合も、`invalid_state` を返す。`detail` は `{ meeting_state, sharing_policy }` とする。`material_ref` は席固有資料に限る。パケット参照は段階 (0) で `invalid_argument` とする（§2.2）。用途別に許容する宛先フィールドは、席間共有（`share_with_seat`）では必須の `to_seat_id` のみとし、`cite_in_synthesis` と `share_external` ではいずれもなしとする。用途に適用できない宛先フィールド（`destination` を含む）が渡された場合、コアは黙って無視せず、段階 (0) で `invalid_argument` を返す。`cite_in_synthesis` の許可範囲は §2.2 に従う。確認を会議内で（資料参照、用途、宛先、`setup_version`）の組として記録する。照合では、資料参照、用途、宛先（必要な場合）が一致し、`setup_version` が会議の現在の値と一致する確認記録だけが有効である。`council.update_setup` の成功で設定版が進むと旧版の確認記録は失効する。確認が必要な資料は最終設定に対して確認を取り直す。`share_external` は、人間がコアの外で資料を手作業で共有する前に作る確認記録である。v1 のコアは席固有資料を他席へ個別に届ける操作を持たない。`share_with_seat` は `share_external` と同様に、人間がコアの外の経路で対象席へ資料を渡す前に作る確認記録である。将来、席間へ資料を届ける操作を追加する場合、コアは実行前に資料参照、用途、宛先、現在の `setup_version` が一致する確認記録を照合し、一致する記録がなければ操作を拒否しなければならない。（PROTOCOL.md §4.2a・§8.1） |

すべての外部呼び出しに認証済み principal が必要。MCP／アプリ／コア API 直接のいずれにも同じ principal モデルを適用する。コアは principal を会議内の役割に写像し、ツールごとの権限を照合する。権限の不一致はエラーとして拒否する（PROTOCOL.md §8.1）。

注：v1のCLI席では、事務局ホストのアダプタ層がCLIを起動して `submit_answer` 等を代理で呼ぶドライバ経路を主とする。直接MCP経路では、独立に稼働中のエージェントが同じツール群を自分で呼ぶ。人間が操作する場合は同じツール群をアプリ/別クライアント経由で叩く想定（議長が人間の場合も専用UIは用意せず、`chair_gate`/`synthesize` を同じクライアント経由で発行する、PROTOCOL.md §1）。

ツール名前空間は `council.*` で確定。将来の管理系ツール（会議の強制終了・バックエンド切替等）は `council.admin.*` に分離する。

`get_packets` の両ビューでは、`attest` パケットの応答上のオブジェクトに、対象転記版の `packet_id` を示す文字列 `target_packet_id` をメタデータとして付ける。値はコアの確定記録から取得する。`attest` パケットには常に付け、他の kind のパケットでは省略する。attest 本文は PROTOCOL.md §3.2 の固定形のままとする。席入力ビューでは `new_packets` の各要素がこのオブジェクトに当たり、監督ビューでは各要素の `packet` がこのオブジェクトに当たる（PROTOCOL.md §3.1）。

`council.get_packets` の監督ビューでは、以下の型と表に従って `packet_state` を割り当てる（PROTOCOL.md §4.2a）。`packet_state` はパケット（版）の状態を表す。`version` は全 kind 共通で差し替えを反映する。席の状態である `absent` / `waived` は `packet_state` に現れず、`get_state` の受領表で確認する。`verification` が `verified` / `unverified` になるのは Web 席の `answer` / `critique` のみで、その他は `not_applicable` とする。

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

### 全ツール共通のエラー形式

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

`reception_state` は処理位置での対象席の受領状態とする。`target_reception_state` は、対象が attest の文脈での版（PROTOCOL.md §4.2a）の場合は処理位置でのその席の受領状態、版でない対象（`flash`、`note`、`agenda` 等）の場合は `null` とする。`round_frozen` はその位置で対象ラウンドが凍結済みかを示す真偽値とする。対象ラウンドが未開始の場合、受領状態は `null`、`round_frozen` は `false` とする。

`deadline_eligible` は初回提出・初回転記では当該操作の受信時刻で判定する。差し替えでは接続種別を問わず PROTOCOL.md §4.1 の継承規則に従い、初版の締切適格性を継承する。接続種別の不適合による段階 (4) の拒否でも、同じ規則で算出した `deadline_eligible` を `detail` に含める。対象ラウンドが未開始の場合は `null`、開始済みで締切がなければ `true` とする。`submit_attest` と `submit_flash` に締切適格性の概念はない。`submit_flash` を議長ロールで呼び出した場合は `reception_state` を `null` とする。

検査は全体順序上の当該操作の処理位置で行う。以下の段階と分岐に従い、最初に該当するエラーを返す。

0. **形式検査**。状態を参照せず、型・必須項目・書式（タイムゾーン指定を含む）と、検索を要しない許容値・引数間の一致を検査する。違反は `invalid_argument` とする。 `create_meeting` の `seat_ids` がリクエスト内の席を指すことの検査もこの段階で行う。
1. **認可**。未知の会議と、呼び出し主体が参加していない実在会議には、区別できない同じ `unauthorized` を返す。対象に依存しない主体・役割の認可を対象検索より先に行い、失敗した場合は `unauthorized` を返す。
2. **検索を要する引数検証**。`supersedes` と当該ラウンド・席の現行版（attest 不一致で現行版がない場合は `invalidated_packet_id` が指す版）の照合は、接続種別を問わず `submit_answer` と `transcribe_web_seat` に共通の規則で行う。検索を要する attest 証拠の突合は、後継版の `hash_match` で対象が本文を持つ転記版の場合に限り、この段階で行う。引数の契約違反は `invalid_argument` とする。対象席が存在しない場合は照合を行わず、次の段階へ進む。処理時点より厳密に過去の締切上書きの検査もこの段階で行う。 `update_setup` の `seat_ids` が更新後の設定に含まれる席を指すことの検査も、保存済みの現行設定を参照してこの段階で行う。保存済み設定を要する `update_setup` の更新後の設定の検証（接続種別の変更後のクォータ検証を含む）もこの段階で行う。
3. **参照先の存在確認**。認可済みの呼び出し主体に対し、指定された参照先が存在しない場合は `not_found` を返す。
4. **状態検査**。クォータを含む状態の前提条件を検査する。違反は `detail` 付きの `invalid_state` とする。

対象に依存しない認可は段階 (1) で行い、対象の検索に先行する。議長限定の操作では、非議長には対象席の存否にかかわらず `unauthorized` を返す。対象に依存しない認可を通過した呼び出し主体が存在しない席を指定した場合は、段階 (3) で `not_found` を返す。その席として行動する権限など、対象に依存する認可は対象の解決後に判定し、権限がなければ `unauthorized` を返す。

`R0` / `R1` / `R2` は会議の構造として開始前から存在する。未開始ラウンドでも段階 (2) の版照合を行う。このとき照合対象の版はなく、非 `null` の `supersedes` は `invalid_argument` とする。先行する段階の検査を通過した場合に限り、未開始のラウンドへの提出は段階 (4) で `invalid_state` とし、`detail` には上記の未開始時の値を用いる。この列挙に含まれない `round` の値は段階 (0) の形式検査で `invalid_argument` とする。

操作は段階 (1) の検索前認可と検索後認可の間に対象検索を挟める。検索前認可を通過し、対象が存在しなければ、その時点で段階 (3) の `not_found` を返す。対象が存在すれば検索後認可を行い、認可が完了してから段階 (2) 以降に進む。

例外として、`confirm_share` では検索分岐の一般則に優先して、すべての参照解決（資料・宛先席）に先立ち設定版を照合する。版が一致した場合にだけ参照を解決する。設定版の不一致と宛先席の不存在が重なれば、版不一致による `invalid_state` が優先する（PROTOCOL.md §4.2a）。

`submit_answer` と `transcribe_web_seat` の入力型は `supersedes?: string | null` とする。明示的な `null` は省略とまったく同じ扱いとする。照合に失敗し、対象ラウンドも凍結済みの場合は、段階 (2) で `invalid_argument` を返す。この場合の `detail` は不要とする（PROTOCOL.md §3.4）。

attest は共通検査順の検索前認可・対象検索・検索後認可の分岐を用いる。(a) を段階 (1) で行い、(b) で参照先がなければ段階 (3) の `not_found` を返す。参照先があれば (c) で認可を完了してから、段階 (4) の状態検査に進む。後継版の `hash_match` で対象が本文を持つ転記版の場合に限り、状態検査の前に段階 (2) の証拠の引数検証を行う（PROTOCOL.md §4.3）。

| コード | 適用条件 |
|---|---|
| `invalid_argument` | 型・契約違反 |
| `unauthorized` | 未知の会議、当該会議への未参加、または主体・役割の不一致 |
| `not_found` | 共通検査順に従い、会議参加主体が未知のパケット・席を指定した場合、`synthesize` の `cited_materials` が存在しない資料またはパケットを参照した場合、または `confirm_share` で設定版の一致後に資料参照が現行設定に見つからない場合 |
| `invalid_state` | 状態の前提条件違反（クォータ超過を含む） |

---

## 4. アプリ画面一覧とLINE対応表

| LINEの概念 | 本アプリでの対応 | 備考 |
|---|---|---|
| トーク一覧 | セッション（会議）一覧 | 未読バッジ＝新着回答（received直後で未読の席回答数）。 |
| トークルーム | 会議スレッド | 席ごとのアイコン・名前・吹き出し。議長はシステムメッセージ枠で表示。 |
| 既読表示 | 受領状態の可視化 | pending=未読相当、received=既読、absent/waived はグレーアウト＋ラベル。 |
| グループ設定 | 席の構成と文脈契約の編集 | SeatConfig・ChairConfig・quorum・deadlineをここで設定。 |
| ノート | 統合結果（synthesis）の固定表示 | `SYNTHESIZING` → `AWAITING_APPROVAL` への遷移時に会議につき1回生成する synthesis をピン留めし、4必須フィールドを常時展開する。ラウンド途中の議長の論点整理は `flash` として表示する。 |
| 入力欄 | ユーザーの投稿／途中介入 | 会議作成時の `create_meeting` 呼び出しで `topic` を渡す。会議中の追加発言は `council.post_message` で投稿し、議長への指示・補足として扱う（§3）。 |
| 未読メンバー表示 | 回答待ちの席がスレッドに残る表示 | 受領待ちの席は `pending` と表示する。API の `reception_table.state` が `transcribed_pending_attest` の席は、ラウンドの締切の有無にかかわらず、画面では `pending` に「未検証（確認待ち）」バッジを添えて表示する（PROTOCOL.md §4.1・§7）。 |

画面一覧（最小セット）：
1. セッション一覧画面
2. 会議スレッド画面（速報/本答の視覚区別、受領状態バッジ、未検証マーク、`get_state` の `timeout_exceeded` に基づくシステム表示を含む）
3. 会議設定画面（席構成・文脈契約・締切・クォーラム・会議タイムアウト）
4. ノート（統合結果）詳細画面
5. Web 席の手渡し転記画面（Phase 2。transcribe + attestフロー。v1の正式手順は完全手動コピペであり、この画面は保存済み本文の `body_sha`（PROTOCOL.md §4.3）を表示して目視照合を補助するのみ。ハッシュの自動取得・ブラウザ連携は行わない）
6. プッシュ通知設定画面（ラウンド完了・ゲート結果・承認待ちの3種のみ。`timeout_exceeded` はプッシュ通知に含めない）

---

## 5. セッション設定項目

ラウンド開始時の `deadline` は下記の順序で決定する。

会議（セッション）作成時にユーザーが設定する項目：

- **席構成**：参加する席のリストと各席のSeatConfig（接続手段/利用条件/能力ラベル）。
- **文脈契約**：席ごとのrole・共通資料参照・席固有資料参照・sharing_policy・tool_access。
- **議長**：v1 の議長は、席・人間・席を持たないエージェント principal のいずれでもよい。
- **締切**：全ラウンドの `deadline` は絶対時刻・相対期間の両形を受け付ける。締切は全ラウンド共通の次の順序で決定する（PROTOCOL.md §4.1）。
  1. 当該ラウンドを開始する `council.open_round` の `deadline` が指定されていれば採用する。相対期間は当該ラウンドの開始時刻を起点とする。
  2. R0開始時に凍結した当該ラウンドの保存設定に有効な `deadline` があれば採用する。相対期間は当該ラウンドの開始時刻を起点とし、絶対時刻は保存設定の規則に従って評価する。
  3. 直前ラウンドで解決された締切が相対期間に基づく場合は、その期間を当該ラウンドの開始時刻に再アンカーして継承する。直前ラウンドの絶対締切は継承しない。
  4. いずれもなければ当該ラウンドは締切なしとし、会議タイムアウトを別途適用する。
- R2 にも上記の締切の決定順序を適用する。Fail 時の `chair_gate` の `r2_deadline` が手順1の呼び出し時指定に当たり、手順3の直前ラウンドはR1とする。
- 絶対締切は、保存設定なら当該ラウンドの開始時に、呼び出し時の上書きなら当該操作の処理時点に、変換する。ISO 8601 の入力は小数部を含む正確な値として解釈し、時計ペアから導いたオフセットを用いてコアの単調時計の尺度に移す。変換を行うステップで同時に読み取った時計ペア（壁時計値、単調時計値）からオフセットを導く。変換した締切の単調時計値は確定し、再計算しない。元の ISO 8601 値は表示用に保持し、締切の比較はすべて単調時計の尺度で正確に行う。変換および比較では丸めも切り捨ても一切行わない。R0・R1・R2の保存設定（`create_meeting` / `council.update_setup` / reopen 継承）の絶対締切は、ラウンド開始時点で未来の場合に限り採用する。それ以外は記録して読み飛ばし、締切の決定順序の次の規則へ進む。締切が決まらなければ、そのラウンドは締切なしとし、会議タイムアウトを別途適用する。設定時点で過去であること自体はエラーにしない。上書き引数（`council.open_round` の `deadline` または `chair_gate` の `r2_deadline`）に当該操作の処理時点（PROTOCOL.md §1.5）より厳密に過去の絶対時刻を指定した場合、時刻差がどれほど小さくてもコアは呼び出しを `invalid_argument` で拒否する。処理時点と同時刻の指定は過去とみなさない。保存設定の読み飛ばし規則は上書き引数には適用しない。受理した上書きによるラウンド締切のスイープは、変換後の締切時刻を使って全体順序に置く。（PROTOCOL.md §1.3・§4.1）
- **会議タイムアウト**：入力契約は §3、適用条件は PROTOCOL.md §1.5 に従う。
- **バリア成立条件**。全必須席が終端の受領状態（`received` / `absent` / `waived`）に達した時点で、締切の有無・到来やクォーラムの充足を問わずバリアを凍結する。コアは凍結時に `quorum_met` を計算し、受領集計に記録する。締切スイープは席を終端状態にする一手段である。締切がなく必須席が未確定のままなら、バリアは成立せず会議は待機する。議長は免除（`waive_seat`）または欠席宣言（`declare_absent`）で未確定の席を終端状態にできる。受理された `waive_seat` / `declare_absent` は、現行版の検証状態にかかわらず席の受領状態をそれぞれ `waived` / `absent` にする。版の attest 状態はパケット側の記録に残る。現行版の attest 状態で席の受領状態を判定するのは、席が免除・欠席で終端となる前の `pending`（`transcribed_pending_attest` を含む）または `received` の間に限る。（PROTOCOL.md §4・§4.3）
- **クォーラム**：ラウンド別の `quorum` は任意で、未指定のラウンドにはトップレベルの `quorum` を既定値として適用する。`council.open_round` では、どのラウンドにも `quorum` を指定できない。
- **クォータ**：クォータは席ごと・会議単位の提出受理件数の上限とする。Web 席（手渡し）は既定値4、最大6とし、CLI・API・ローカル席は既定値10、最大20とする。設定と検証は §3 の `SeatConfig.quota` に従う。（PROTOCOL.md §9）
- **安全設定**：外部席回答の`<untrusted>`ラップ（常時ON、変更不可）。
