# release 目录说明

由于 GitHub 单个文件大小限制（100MB），以下打包产物已拆分为多个分片文件提交：

- `imFile-1.1.2-win.zip.part01` + `imFile-1.1.2-win.zip.part02`
- `imFile-1.1.2-x64.appx.part01` + `imFile-1.1.2-x64.appx.part02`
- `win-unpacked/imFile.exe.part01` + `win-unpacked/imFile.exe.part02`

## 在 Windows 上合并

在对应目录打开 PowerShell，执行：

```powershell
cmd /c copy /b imFile-1.1.2-win.zip.part01+imFile-1.1.2-win.zip.part02 imFile-1.1.2-win.zip
cmd /c copy /b imFile-1.1.2-x64.appx.part01+imFile-1.1.2-x64.appx.part02 imFile-1.1.2-x64.appx
cmd /c copy /b win-unpacked\\imFile.exe.part01+win-unpacked\\imFile.exe.part02 win-unpacked\\imFile.exe
```

## 在 Linux 上合并

在仓库根目录执行：

```bash
cat release/imFile-1.1.2-win.zip.part* > release/imFile-1.1.2-win.zip
cat release/imFile-1.1.2-x64.appx.part* > release/imFile-1.1.2-x64.appx
cat release/win-unpacked/imFile.exe.part* > release/win-unpacked/imFile.exe
```
