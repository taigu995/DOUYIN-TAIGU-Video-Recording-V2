; 卸载时清除用户数据
; 此脚本在卸载时执行，清除应用数据和配置

!macro customUnInstall
  ; 获取用户数据目录
  ; Electron 应用数据存储在 %APPDATA%/${productName}
  
  ; 删除配置文件夹
  RMDir /r "$APPDATA\DouyinLiveRecorder"
  
  ; 删除 localStorage 和 IndexedDB
  RMDir /r "$APPDATA\douyin-live-recorder"
  
  ; 删除日志文件夹
  RMDir /r "$APPDATA\DouyinLiveRecorder\logs"
  
  ; 删除缓存
  RMDir /r "$LOCALAPPDATA\DouyinLiveRecorder"
  RMDir /r "$LOCALAPPDATA\douyin-live-recorder"
  
  ; 删除 Electron 的 GPU 缓存
  RMDir /r "$APPDATA\DouyinLiveRecorder\GPUCache"
  RMDir /r "$APPDATA\DouyinLiveRecorder\Cache"
  RMDir /r "$APPDATA\DouyinLiveRecorder\Code Cache"
  
  ; 删除可能的会话数据
  RMDir /r "$APPDATA\DouyinLiveRecorder\Partitions"
  RMDir /r "$APPDATA\DouyinLiveRecorder\Session Storage"
  
  ; 删除注册表项（如果有）
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Run\DouyinLiveRecorder"
  
!macroend
