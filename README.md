# Subflow Live — 穩定共筆改造版

支援一位聽打員持續輸入，其他人同步修正、補字；保留原有聽打工作台、投影設定、觀眾頁、QR 與純文字匯出。

## 這次改造

- 以 Yjs + y-quill 取代自製位置轉換演算法；前後端交換 CRDT 更新，重複重送不會重複插字。
- 每個分頁有獨立協作 ID；姓名、不同顏色游標與選取範圍透過相對文字位置追蹤。
- 中文組字期間，暫存遠端更新，完成選字後再合併。各人捲動與焦點獨立。
- 個人復原只追蹤自己的編輯；清空為獨立可復原操作。
- IndexedDB 保存本機文件。重新整理、斷線重連時合併本機與伺服器文件，不以伺服器全文覆蓋本機稿。
- 伺服器寫入 SQLite 成功後才回覆已儲存；未確認的修改保留並重試。
- 有修改時每分鐘最多自動保留一版，保留最近 120 版；清空前另保留一版。版本可下載，不會覆蓋其他人正在編輯的稿件。
- 觀眾連線不能直接寫入文件或接管投影。`/edit/房號` 仍是原有的編輯邀請入口，知道該網址的人可以編輯；此版沒有新增帳號權限系統。
- 語音辨識的暫時結果只顯示預覽，確認結果才寫入共筆，避免辨識修正造成重複文字。
- 所有編輯器與同步程式資產由本機服務提供，作業中不依賴第三方 CDN。

## 本機啟動

需要 Python 3.11 以上；前端已建置於 `static/`，啟動不需要 Node。

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

開啟 `http://localhost:5000`。編輯網址 `/edit/A` 可讓多人同時加入；觀眾使用 `/view/A`。

## 正式部署

目前使用者是 **Render 免費方案**，請先讀 `RENDER.md`。`render.yaml` 僅提供免費測試設定；免費服務不能承諾伺服器跨部署永久存稿，畫面會明確顯示暫存狀態。此版沒有開通任何付費資源。

這版採 **一個服務實例、一個 Python worker、多執行緒**。請勿開多個 worker 或多副本：協作房間與游標目前由單一程序管理。若要多副本，需要另建跨程序廣播與文件協調，不能僅加 Redis 就視為完成。

Linux 啟動命令（`Procfile` 已提供）：

```sh
gunicorn --workers 1 --threads 32 --timeout 120 --bind 0.0.0.0:$PORT app:app
```

必要部署設定：

| 設定 | 用途 |
| --- | --- |
| `SUBFLOW_DB` | 指向持久磁碟內的完整檔案路徑，例如 `/var/data/subflow.sqlite3`。資料庫、WAL 檔須在同一個持久目錄。 |
| `SECRET_KEY` | 固定的隨機密鑰，保留於服務環境變數。未設定時，會在資料庫同目錄建立 `.editor-secret`，也必須持久保存。 |
| `PORT` | 託管服務分配的埠號。 |

若部署平台的檔案系統會在重啟或部署後清空，必須先掛載持久磁碟，才有跨部署保存的能力。瀏覽器備份不能取代伺服器持久儲存。SQLite 應位於本機持久磁碟，不使用網路共享磁碟；正式使用另安排資料庫備份，可用 SQLite backup API 產生一致快照。

上線替換前，先讓目前使用者匯出舊版逐字稿。舊版只存在程序記憶體的內容無法從 GitHub 還原；2026-10-09 已將改造版上傳至 codex/collaboration-stability 分支並部署至原有 Render 免費服務；main 保留原版。

反向代理需支援 WebSocket，保持同源；Socket.IO 也可退回長輪詢。不要另設開放任意來源的 CORS。

## 修改前端與測試

```sh
npm ci
npm run build
python -m pip install -r requirements-dev.txt
python -m pytest tests/test_server.py -q
npm test
```

瀏覽器測試預設使用已安裝的 Chrome；可設 `BROWSER_CHANNEL=msedge` 改用 Edge。Windows 預設使用 `.venv/Scripts/python.exe`，其他平台使用 `python`；可用 `PYTHON` 指定。測試會自行啟動獨立伺服器、建立暫存資料庫與瀏覽器設定檔；`TEST_WORK` 可指定測試輸出父目錄。`SOAK_SECONDS` 預設 60，可提高為 3600 或整場工作時長。

測試涵蓋多人修改與 Unicode、分頁身分、游標、選取範圍、個人復原、瀏覽器組字事件、斷線重整、伺服器重啟、長篇文件、跨瀏覽器儲存環境、延遲網路、版本備份及觀眾唯讀。

正式驗收仍需兩位以上聽打員使用自己的 Windows 注音／其他輸入法與實際會場網路，連續作業一整場。自動測試的 Chrome 組字事件不是完整的實體鍵盤及作業系統輸入法測試，也不能保證所有衝突都符合人的語意；同時改同一個詞仍需人工判斷。

已知依賴掃描：Quill 2.0.3 的 HTML 匯出功能有低風險公告。本平台停用富文字格式、僅提供純文字匯出，未使用該 HTML 匯出功能；升級 Quill 時需重新驗證中文組字與 y-quill 相容性。
