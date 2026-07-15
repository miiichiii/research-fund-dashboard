# 研究費メインボード

研究費管理のメイン台帳です。Googleログイン後、許可ユーザーだけがFirestore上の研究費台帳を読める構成にしています。

## Purpose

Natto_MASHを別ボードへ分けず、Funds / Allocations / Line items / Open loops をこのメイン台帳で一元管理する。

- 資金枠: 2201教育研究費、2202プロジェクト研究費、7023武田財団、科研費、AMED/橋渡しを横断で見る
- プロジェクト: Natto_MASHなどの配分枠・支出項目・未確認事項も同じ台帳で管理する
- 既存 Natto_MASH ボードは過去参照用。正本はこの研究費メインボードに寄せる。

## Files

- `index.html`: 静的HTML
- `styles.css`: 表示スタイル
- `app.js`: Firebase Auth / Firestore同期と描画ロジック
- `firebase-config.js`: Firebase Web SDK用の公開設定
- `seed.local.js`: Firestore初期投入用のローカル専用データ。公開デプロイに含めない
- `firestore.rules.example`: Firebase Console / private rules用テンプレート

## Firestore

- Firebase project: `project-manage-56fd1`
- Auth provider: Google
- Firestore document: `researchFundDashboards/main`
- Document shape: `{ funds, allocations, lineItems, checks, projects, ipuOrders, updatedAt, updatedBy }`

`ipuOrders` はIPU申請フォーム用の購入候補。`manufacturer`, `itemName`, `specification`, `catalogNumber`, `quantity` を基本に、必要に応じて `unitPriceYen`, `remarks`, `vendor`, `quoteNumber`, `quoteValidUntil` を保存する。表示は `品名 / 規格・品質 / 型番・品番 / 単価 / 備考` の5項目コピーを主にし、品名は名称と会社名を並べ、備考は `○○会社名で見積もり` を自動生成する。単価候補が複数ある場合は `quoteCandidates` などの配列から候補表示できるようにし、金額はカンマなしの半角数字表示にする。不明値は静的ファイルへ埋めず画面では「要確認」と表示する。

`app.js` には研究費の金額や明細を置かない。初期データは `seed.local.js` から、ログイン後に「初期データ投入」でFirestoreへ保存する。

## Security

Firebase Web configは秘密情報ではない。実際の保護はFirestore rulesで行う。

必要なルールは `firestore.rules.example` をベースにして、Firebase Console側の実ルールへ `researchFundDashboards/{dashboardId}` を追加する。実メールアドレス入りallowlistは公開repoへコミットしない。

静的ホスティングは `index.html` / `app.js` 自体を隠さない。研究費金額・内部URL・個人情報・スクショ由来の非公開情報は、公開静的ファイルやgit履歴に入れない。

## Current Data Status

現在の初期投入データは `seed.local.js` に退避済み。公開静的ファイル側には、スクショ由来の残額・明細・内部判断メモを直接置かない。

台帳には次の枠を含める。

- 2201教育研究費（R08・個人）
- 2202プロジェクト研究費（R08）
- 7023奨学寄付金（武田科学 / 武田財団）
- 科研費23K05586（終了済み・履歴保持のためアーカイブ）
- 科研費25H00958
- AMED / 橋渡し関連

## Next

1. 3学会費の支払い済み/未払い、2201教育研究費からの支出可否、支出期限を確認する。
2. 科研費の本人配分/残額、2202プロジェクト研究費と7023奨学寄付金のメンバー/使途制限を入れる。
3. 武田財団の支払手続済明細とAI利用料の費目/継続可否を確認する。
4. Firestore rulesへ `researchFundDashboards` の許可ユーザー制限を追加する。
5. ローカルHTTP（例: `http://localhost:8766/`）で開き、Googleログイン後に初期データ投入を実行する。
6. 公開版にする場合は、`seed.local.js` を含めず、認証済みFirestoreデータだけを読む。
