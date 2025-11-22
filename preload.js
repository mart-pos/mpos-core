const { contextBridge, shell } = require("electron");

contextBridge.exposeInMainWorld("mpcore", {
  openExternal(url) {
    shell.openExternal(url);
  },
});

console.log("PRELOAD CARGADO ✔️");
