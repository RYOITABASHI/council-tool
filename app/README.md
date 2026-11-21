# Council Tool 会議ビューアー

複数の LLM が参加する会議を閲覧する Expo アプリです。ホームの「セッション」から会議を選ぶと、読み取り専用の「会議」画面が開きます。「セッション」と「会議」の右上にある歯車から「設定」を開けます。

## 起動

```sh
npm install
npx expo start
```

Android 実機では、Expo SDK 58 に対応する Expo Go で起動時の QR コードを読み取ります。開発ビルドを使う場合は、Android 用の development ビルドを端末にインストールし、`npx expo start --dev-client` で接続します。ビルド方法は Expo の手順を参照してください。 [Android 環境のセットアップ](https://docs.expo.dev/get-started/set-up-your-environment/) · [開発ビルド](https://docs.expo.dev/develop/development-builds/introduction/)

## サンプル会議

ファサード URL を空にすると、ホームに同梱の実会議 2 件が表示されます。行をタップすると、その会議の状態とパケットを閲覧できます。セッション一覧から会議を開くまで、サーバー接続は不要です。

- `src/fixtures/meetings.json` に一覧用の会議概要を収録しています。
- `src/fixtures/live/` に会議 `97161c6b-8642-4a7e-bf78-4be1df5035bf` の状態とパケットを収録しています。
- `src/fixtures/proof/` に会議 `47445a40-d277-45c5-9349-eb7189de2ce3` の状態とパケットを収録しています。

## ファサード接続

「設定」の「接続」で、端末からアクセスできるファサードのベース URL と、サーバー側の `COUNCIL_HTTP_TOKEN` に対応するトークンを入力し、「保存」を押します。アプリ側の環境変数は不要です。接続設定は端末の AsyncStorage に保存されます。

ファサードへのリクエストには `Authorization: Bearer <token>` ヘッダーが付きます。

- `GET /meetings` でセッション一覧を取得します。
- `GET /meetings/{meetingId}/state` で会議状態、ラウンド、受理状況を取得します。
- `GET /meetings/{meetingId}/packets` で oversight ビューのパケットを取得します。

ファサード接続時は一覧を引っ張って更新できます。取得に失敗すると「再試行」と「サンプル会議一覧を見る」が表示されます。会議画面は「更新」または引っ張って再取得できます。

共有された会議 ID がある場合は、「設定」の「会議IDで開く」に入力して「開く」を押します。ファサード URL が空の場合は同梱データから会議を探します。

## 呼び出すエージェント

「設定」で Codex (CLI)、Claude Code (CLI)、API席、ローカル席を選択できます。初期選択は Codex (CLI) と Claude Code (CLI) です。選択は端末に保存され、次のインクリメントのセッション作成で使われます。この版の会議は閲覧専用です。

## 表示スタイル

- **ライン風**は、発言や照合結果をラウンド順に並べたタイムラインです。
- **スレッド風**は、発言をラウンドごとのセクションにまとめます。

「設定」または会議画面で選んだスタイルが保存され、次に会議を開くときに使われます。統合結果はどちらの表示でも末尾にあります。
