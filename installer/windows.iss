#ifndef PackageDir
  #error PackageDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef InfoFile
  #error InfoFile is required
#endif

#define AppName "ChatGPT 远程助手"

[Setup]
AppId={{B98F4E8B-9CF9-4C68-9718-376041F08A25}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}.0
VersionInfoTextVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}.0
VersionInfoProductTextVersion={#AppVersion}
AppPublisher=ChatGPT 远程助手项目
AppComments=独立的非官方 Codex 桌面连接工具
DefaultDirName={localappdata}\Programs\CodexMobile
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19041
WizardStyle=modern
WizardSizePercent=110
SetupIconFile={#PackageDir}\companion.ico
UninstallDisplayIcon={app}\RemoteCompanion.exe
UninstallDisplayName={#AppName}
OutputBaseFilename=ChatGPT-Remote-Assistant-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
InfoBeforeFile={#InfoFile}
CloseApplications=no
RestartApplications=no
Uninstallable=yes
UsePreviousAppDir=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："

[Files]
Source: "{#PackageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\RemoteCompanion.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\RemoteCompanion.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\RemoteCompanion.exe"; Description: "运行 {#AppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Target, DataRoot: String;
begin
  Result := '';
  Target := AddBackslash(ExpandFileName(WizardDirValue));
  DataRoot := AddBackslash(ExpandConstant('{localappdata}\CodexMobile'));
  if CompareText(Copy(Target, 1, Length(DataRoot)), DataRoot) = 0 then
    Result := '不能安装到助手的数据目录。请选择默认的 Programs\CodexMobile 程序目录。';
end;

function OpenMutex(dwDesiredAccess: DWORD; bInheritHandle: Boolean; lpName: String): THandle;
  external 'OpenMutexW@kernel32.dll stdcall';
function CreateEvent(lpEventAttributes: Integer; bManualReset, bInitialState: Boolean; lpName: String): THandle;
  external 'CreateEventW@kernel32.dll stdcall';
function SetEvent(hEvent: THandle): Boolean;
  external 'SetEvent@kernel32.dll stdcall';
function WaitForSingleObject(hHandle: THandle; dwMilliseconds: DWORD): DWORD;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function FindWindow(lpClassName: Integer; lpWindowName: String): THandle;
  external 'FindWindowW@user32.dll stdcall';
function GetWindowThreadProcessId(hWnd: THandle; var lpdwProcessId: DWORD): DWORD;
  external 'GetWindowThreadProcessId@user32.dll stdcall';

function InitializeSetup(): Boolean;
var
  Release: Cardinal;
  Mutex, Signal, Window: THandle;
  ProcessId: DWORD;
  ExitCode: Integer;
begin
  Result := RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', Release) and (Release >= 528040);
  if not Result then begin
    MsgBox('需要 .NET Framework 4.8 或更新版本。请通过 Windows 更新安装后重试。', mbError, MB_OK);
    Exit;
  end;

  Mutex := OpenMutex($00100000, False, 'Local\CodexMobileCompanion');
  if Mutex = 0 then Exit;
  try
    if not WizardSilent then
    if MsgBox('安装程序检测到 ChatGPT 远程助手当前正在运行。' + #13#10 + #13#10 +
      '点击“确定”将自动退出助手并继续安装；点击“取消”退出安装。', mbConfirmation, MB_OKCANCEL) <> IDOK then begin
      Result := False;
      Exit;
    end;
    Signal := CreateEvent(0, False, False, 'Local\CodexMobileCompanion.Exit');
    if Signal <> 0 then begin
      SetEvent(Signal);
      CloseHandle(Signal);
    end;
    if WaitForSingleObject(Mutex, 15000) <> 0 then begin
      Window := FindWindow(0, 'ChatGPT 远程助手');
      if Window = 0 then Window := FindWindow(0, '远程伴侣');
      if Window <> 0 then begin
        GetWindowThreadProcessId(Window, ProcessId);
        if ProcessId <> 0 then
          Exec(ExpandConstant('{sys}\taskkill.exe'), '/PID ' + IntToStr(ProcessId) + ' /T /F', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
      end;
    end;
    Result := WaitForSingleObject(Mutex, 15000) = 0;
    if not Result then MsgBox('无法自动退出正在运行的助手，请从系统托盘退出后重新安装。', mbError, MB_OK);
  finally
    CloseHandle(Mutex);
  end;
end;
