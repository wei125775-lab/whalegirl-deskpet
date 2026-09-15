@echo off
rem 鲸鱼娘桌宠 · Claude/PetPet 版一键安装（双击即可）
rem 想预览会改什么：install.cmd --dry-run
setlocal
node "%~dp0install.mjs" %*
echo.
pause
