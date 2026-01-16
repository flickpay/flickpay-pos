FlickpayPOS – Dual Screen Browser
================================

Shortcuts (engineers):
- Ctrl + Alt + S : Open settings window
- Ctrl + Alt + R : Reload both screens
- Ctrl + Alt + Q : Quit app
- Ctrl + Alt + O : Show config file in Explorer

Settings storage:
- Created automatically on first run:
  C:\Users\<User>\AppData\Roaming\FlickpayPOS\config.json

Branding assets (replace these with your own):
- assets/icon.ico   (Windows app + installer icon)
- assets/icon.png   (source/preview icon)
- assets/splash.png (fullscreen splash image on both screens)
- assets/splash.html (splash page)

Build on Windows:
1) Install Node.js (LTS)
2) In this folder:
   npm install
3) Test:
   npm start
4) Build installer:
   npm run dist

Installer output:
- dist\FlickpayPOS Setup 1.0.2.exe
