const { app, BrowserWindow } = require("electron");
const http = require("http");
const fs = require("fs");

const oldProfile = process.argv[2];
const output = process.argv[3];
const port = 53645;
if (!oldProfile || !output) throw new Error("usage: electron extract-localstorage.cjs PROFILE OUTPUT");
app.setPath("userData", oldProfile);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>ClipForge migration</title>");
});

server.listen(port, "127.0.0.1", async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on("did-finish-load", async () => {
    try {
      const values = await win.webContents.executeJavaScript(`(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) out[key] = localStorage.getItem(key);
        }
        return out;
      })()`);
      fs.writeFileSync(output, JSON.stringify(values), { mode: 0o600 });
    } finally {
      server.close();
      app.quit();
    }
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
});
