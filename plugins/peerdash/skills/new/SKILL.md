---
name: new
description: Make a new peerdash dashboard and get its share link.
argument-hint: "[title or what the dashboard is about]"
---

Make a new peerdash dashboard.

1. Call the `new_dashboard` tool. Use a short title from this request:
   $ARGUMENTS
   If the request is empty, use "Untitled dashboard".
2. Give the user the link and ask them to open it in their browser.
3. If the request says what the dashboard is about, follow the `peerdash`
   skill and add a first set of widgets.
