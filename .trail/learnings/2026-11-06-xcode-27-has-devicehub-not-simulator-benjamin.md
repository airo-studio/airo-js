---
title: "Xcode 27 has DeviceHub, not Simulator.app: device checks can be tapped by hand"
author: Benjamin
date: 2026-11-06
branch: lynx-adapter
cost: { minutes: 3, tokens: 35825 }
touches:
  - TODOS.md
  - device-run/mounted.json
  - device-run/navigated-1.json
  - device-run/navigated-2.json
  - device-run/navigated-3.json
  - device-run/navigated-4.json
  - device-run/navigated-5.json
  - device-run/navigated-6.json
  - device-run/navigated-7.json
  - device-run/screen-after.png
---

## Decided
- In Xcode 27, DeviceHub replaces Simulator.app: `Xcode.app/Contents/Applications/DeviceHub.app`. Open it to see and tap the booted simulator during a device check (`device-check.mjs --watch N`).

## Tried and ruled out
- Concluding the simulator UI was missing because the old `Simulator.app` path was empty. That was a misreading, not a broken install; no Xcode reinstall is needed (it only added the iOS 27.2 runtimes, which are harmless).

## Watch out
- This corrects the "ships no Simulator.app" line in the Nov 6 learning on Lynx layout quirks: taps still cannot be scripted (`__DispatchEvent` never reaches listeners), but they can be made by hand in DeviceHub.
