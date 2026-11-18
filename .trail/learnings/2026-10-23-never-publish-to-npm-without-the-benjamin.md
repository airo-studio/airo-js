---
title: "Never publish to npm without the user's explicit go"
author: Benjamin
date: 2026-10-23
standing: true
---

## Decided
npm publishing is a separate step that waits for the user to say go. Before asking, make sure the consumers who need the fix have confirmed and CI is green. Then run `publish.sh --apply`.

## Watch out
The user's go to merge, push or open a PR is not a go to publish.

_Told to Claude in 2 past sessions here, most recently on Oct 19._
