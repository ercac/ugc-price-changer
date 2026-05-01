# UGC Price Changer

A Chrome extension (Manifest V3) for managing user-generated content (UGC) marketplace listings. Provides a lightweight dashboard for tracking owned items, monitoring market activity, and updating listing prices from a single popup.

## Features

- **Inventory dashboard** — view owned UGC items with thumbnails, current listing state, and per-item price details
- **Watchlist** — track items of interest and monitor availability
- **Bulk price management** — update listing prices across multiple item instances with a single action
- **TOTP authenticator** — built-in time-based one-time password generator (RFC 6238) for accounts with two-factor authentication
- **Multi-account support** — per-account storage scoping so settings and lists stay isolated when switching accounts
- **Search & pagination** — filter inventory and page through large item lists

## Tech

- Vanilla JavaScript, HTML, CSS — no frameworks or build step
- Chrome Extensions Manifest V3 (service worker background)
- Web Crypto API (HMAC-SHA1) for TOTP generation
- `chrome.storage.local` for persistence, scoped per user
- Resilient HTTP client with token refresh, request throttling, and exponential backoff

## Project layout

```
manifest.json   - extension manifest
popup.html      - popup UI
popup.css       - popup styles
popup.js        - popup logic, tab routing, item rendering
background.js   - service worker: API client, storage, TOTP, scheduler
icons/          - extension icons
```

## Install (development)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this directory
4. Pin the extension and open the popup to start

## Usage

Open the popup and use the tab bar to switch between **Sell**, **Watch**, and **2FA** views. Add items by ID or catalog URL.
