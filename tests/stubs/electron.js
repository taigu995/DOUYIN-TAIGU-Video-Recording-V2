
module.exports = { app: { getPath: () => require('os').tmpdir(), getVersion: () => 'test' }, BrowserWindow: class {}, ipcMain: { handle(){}, on(){} } };
