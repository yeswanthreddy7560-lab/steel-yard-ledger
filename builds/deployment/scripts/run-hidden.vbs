' ================================================================
' Hidden launcher for Windows scheduled tasks.
'
' Task Scheduler runs this script with wscript.exe, so no console
' window appears. It starts the requested command with a hidden
' window, waits for it to finish, and returns its exit code.
'
' Usage:
'   wscript.exe //B //Nologo run-hidden.vbs "<exe>" "<arg>" ...
' ================================================================

Option Explicit

Dim shell, command, index, argument, exitCode

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

command = ""
For index = 0 To WScript.Arguments.Count - 1
  argument = WScript.Arguments(index)
  If InStr(argument, " ") > 0 Then
    argument = Chr(34) & argument & Chr(34)
  End If
  command = command & argument & " "
Next

Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(Trim(command), 0, True)
WScript.Quit exitCode
