# 現有 Render 免費服務上線方式

2026-10-09 已將穩定共筆改造版部署至 https://subflow-live.onrender.com/ ，沿用原本 Render 免費服務。部署分支 codex/collaboration-stability，程式版本 d2f18aeb830cc07fbd141f7a2cfec517407e2cdc。Render 顯示 Deploy succeeded／Live，/healthz 回報 status=ok、durable_storage=false；未建立付費資源。啟動使用單一 Gunicorn worker、32 threads、健康檢查 /healthz，Auto-Deploy 已設為 Off，後續更新須手動部署。未設定 SECRET_KEY 環境變數時，重新部署後舊編輯頁可能需重新整理取得新權杖；本機備份會重新合併。

## 免費方案可測試的範圍

共筆同步、游標、中文組字保護、個人復原與離線修改合併皆可使用。免費 Render 沒有持久磁碟：SQLite 的稿件及版本會在服務檔案系統重建時消失；瀏覽器 IndexedDB 是此時保留稿件的主要備份。使用者清除網站資料、使用無痕模式或失去原裝置時，不能靠它保證復原。

因此免費環境的狀態會顯示 **「已同步至夥伴／本機備份；伺服器僅暫存」**，不會顯示永久存稿完成。仍請定期下載逐字稿。

Render 免費服務閒置 15 分鐘後會休眠，喚醒需等待。這不是編輯器演算法可以消除的限制。正式多人聽打的連續可用性與稿件永久保存，需要另外確認託管方案。

## 更新現有服務

1. 目前稿件先下載，安排非聽打作業時間替換版本。
2. 將此修改版放到 GitHub 測試分支，先關閉現有服務 Auto-Deploy，避免更新即替換現場網站。
3. 在現有服務的 Settings 設定以下內容，並確認部署的是測試分支或已審查版本：

| 欄位 | 值 |
| --- | --- |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn --workers 1 --threads 32 --timeout 120 --bind 0.0.0.0:$PORT app:app` |
| Health Check Path | `/healthz` |
| Instances | `1` |

4. 在 Environment 設定：

| 變數 | 值 |
| --- | --- |
| `PYTHON_VERSION` | 若原本有設定，先移除此變數，讓專案的 `.python-version` 選用 3.13 系列最新修補版。若保留環境變數，須指定完整版本號，並確認為 3.13 系列。 |
| `SECRET_KEY` | 在 Render 產生固定隨機值，保留為環境機密，不貼到聊天或 GitHub |
| `SUBFLOW_DB` | `/tmp/subflow/subflow.sqlite3` |
| `SUBFLOW_DURABLE_STORAGE` | `0` |

5. 手動 Deploy，確認 `/healthz` 回傳 `status: ok`、`durable_storage: false`。
6. 兩位以上使用自己的裝置與輸入法加入相同 `/edit/房號`，另開 `/view/房號` 驗收。先測試房號，不直接使用當前工作中的 A/B/C。

`render.yaml` 是等效的免費 Blueprint 範例。現有服務若尚未由 Blueprint 管理，請按上述欄位更新；不要僅為套用檔案而另建重複服務。檔案本身不會替你變更現有設定。

## 正式跨部署保存

需要明確決定付費持久磁碟或外部持久資料庫後再上線。此版本已完成 SQLite 存稿；外部資料庫尚未實作。

若選用 Render 付費服務與磁碟：在 Dashboard 掛載磁碟至 `/var/data`，把 `SUBFLOW_DB` 改為 `/var/data/subflow.sqlite3`，確認該路徑確實持久保存後，才把 `SUBFLOW_DURABLE_STORAGE` 改為 `1`。狀態才會顯示「所有修改已儲存」。此標記不會自行建立磁碟。

## 官方參考

- [Render 免費方案限制](https://render.com/docs/free)
- [持久磁碟](https://render.com/docs/disks)
- [Python 版本設定](https://render.com/docs/python-version)
- [Blueprint 欄位](https://render.com/docs/blueprint-spec)
