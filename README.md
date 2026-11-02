# 留言影片 App（message-video-app）

大家點連結 → 填寫問題 → 送出後**立刻**生成一段影片：一句一句播放大家寫的話，
背景圖片和背景音樂都可以在後台自己換。

## 一、需要的軟體

| 軟體 | 用途 | 下載 |
|---|---|---|
| Node.js（18 版以上） | 執行伺服器 | https://nodejs.org （選 LTS） |
| VS Code（建議） | 編輯程式碼 | https://code.visualstudio.com |
| 瀏覽器 Chrome / Edge / Safari | 填寫與生成影片 | — |
| Render / Railway 帳號（上線用） | 讓大家可以用連結進來 | https://render.com |

不需要安裝影片軟體：影片是在填寫者的瀏覽器裡直接合成的（Canvas + MediaRecorder），
所以伺服器不用負擔運算，也不用花錢。

## 二、在自己電腦上跑起來

```bash
cd message-video-app
npm install          # 安裝 express、multer
npm start            # 啟動
```

- 填寫頁面：http://localhost:3000/
- 管理後台：http://localhost:3000/admin.html （預設密碼 `admin123`）

改密碼（強烈建議）：
```bash
# Mac / Linux
ADMIN_PASSWORD=你的密碼 npm start
# Windows PowerShell
$env:ADMIN_PASSWORD="你的密碼"; npm start
```

## 三、後台可以調整的東西

- 標題、說明文字、問題（可新增／刪除）
- 背景圖片、背景音樂（上傳檔案就會套用）
- 每句話顯示幾秒、字體大小、文字顏色、背景變暗程度
- 畫面比例：16:9 橫式，或 9:16 直式（適合手機和限動）
- 查看所有回覆、幫某一份回覆生成影片、把**全部人**的話合成一支影片、匯出 JSON

## 四、上線產生連結（以 Render 為例）

1. 把這個資料夾上傳到 GitHub（新建一個 repository）。
2. 到 render.com → New → **Web Service** → 選這個 repo。
3. Build Command：`npm install`；Start Command：`npm start`。
4. Environment 加上 `ADMIN_PASSWORD` = 你的密碼。
5. 部署完成後會拿到網址，例如 `https://xxx.onrender.com`，把它傳給大家就好；
   後台是 `https://xxx.onrender.com/admin.html`。

⚠️ Render 免費方案重新部署或休眠後，硬碟上的檔案（回覆、上傳的圖片和音樂）可能會被清掉。
解決方法：在 Render 加一顆 **Persistent Disk** 掛在專案的 `data` 和 `public/uploads`，
或改用 Railway（加 Volume）、自己的主機。活動當天用的話，記得事後馬上去後台「匯出 JSON」備份。

## 五、檔案說明

```
message-video-app/
├── package.json        套件設定
├── server.js           後端：存設定、存回覆、上傳圖片音樂
├── data/               （自動產生）config.json、responses.json
└── public/
    ├── index.html      填寫頁面（大家點連結看到的）
    ├── admin.html      管理後台（你用的）
    ├── video.js        影片生成核心
    ├── style.css       外觀
    └── uploads/        （自動產生）上傳的圖片、音樂
```

## 六、注意事項

- 影片長度 = 片頭約 3 秒 + 句數 × 每句秒數 + 片尾約 2.5 秒。生成是「即時錄製」，
  所以影片多長就要等多久，錄製期間請保持頁面在前景。
- 下載格式：Safari 和新版 Chrome 會存成 .mp4，較舊的瀏覽器會存成 .webm
  （LINE、IG 不收 webm 的話，可以用 CloudConvert 之類的工具轉成 mp4）。
- 背景音樂請使用你有權使用的音樂，例如 YouTube 音樂庫的免版稅音樂。
