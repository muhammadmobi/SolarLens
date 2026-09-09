' Starts the relay with no console window.
'
' node.exe is a console application, so Windows gives it a window whenever the
' scheduled task starts it - a black terminal appearing at every logon and
' sitting there for as long as the relay runs. Task Scheduler's own "Hidden"
' setting does not help: that hides the task from the Task Scheduler list, not
' the window from the desktop.
'
' The usual fix is to register the task with an S4U principal so it runs off
' the interactive desktop, but that needs an elevated prompt, and asking for
' administrator rights to stop a window appearing is a poor trade. WScript.Run
' with a window style of 0 does the same job from an ordinary account.
'
' Run with True (wait) rather than False: the script then lives exactly as long
' as the relay does, so Task Scheduler still shows the task as running, its
' restart-on-failure settings still mean something, and Stop-ScheduledTask
' still stops the relay.
'
' Usage:  wscript.exe //nologo relay-hidden.vbs ["C:\path\to\node.exe"]
'         The argument is optional; "node" from PATH is used without it.

Option Explicit

Dim fso, shell, root, nodeExe, cmd
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' This file lives in scripts\, so the repository is its parent's parent.
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

If WScript.Arguments.Count > 0 Then
  nodeExe = WScript.Arguments(0)
Else
  nodeExe = "node"
End If

shell.CurrentDirectory = root
cmd = """" & nodeExe & """ """ & fso.BuildPath(root, "agent\solis-relay.mjs") & """"

' 0 = no window, True = wait for it to finish.
WScript.Quit shell.Run(cmd, 0, True)
