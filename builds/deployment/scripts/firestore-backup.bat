@echo off
rem Daily free Firestore export (no Google billing involved).
cd /d "%~dp0.."
node scripts\firestore-backup.js >> data\firestore-backup.log 2>&1
