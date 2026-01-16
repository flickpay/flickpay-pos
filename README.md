# FlickpayPOS

**FlickpayPOS** is the official Windows POS launcher application for Flickpay.

It is designed for locked-down / kiosk environments and supports:
- Dual screen setup (Operator + Customer display)
- Built-in Settings panel (PIN protected)
- Self-service kiosk mode (optional token support)
- Remote support shortcut
- Auto-update via GitHub Releases (silent download, installs on next quit)

---

## Downloads / Updates
Updates are delivered automatically through **GitHub Releases**.

To publish a new version:
1. Update the version number in `package.json`
2. Build + publish:

```bash
npm run dist -- --publish always
