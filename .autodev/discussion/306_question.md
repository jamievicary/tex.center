# Toast UX + debug mode + compile-cycle telemetry

A batch of toast/debug-related changes I'd like landed together (probably in one iteration). Each item is small; together they form a coherent UX improvement.

1. **Debug mode should be settable via the settings cog menu.** Today it's only togglable via `?debug=1` URL param or Ctrl+Shift+D. Add a checkbox/toggle to the settings popover (next to the existing cross-fade slider).
2. **Debug mode should be on by default.** Persisted state still wins (so an explicit off stays off), but a first-time visitor should see the toasts without having to know about the URL/keyboard surface.
3. **Default cross-fade transition time: 1 second.** (Current default is 250 ms per `settingsStore`.)
4. **Toasts need to animate down when they move vertical position.** Today new toasts pop in at the top and existing ones jump down instantaneously. Animate the downward shift.
5. **Toasts need to move down quite slowly.** Make the move-down animation deliberate — e.g. 400-600 ms with an easing curve, not snappy. The goal is for the user to visually track each toast as it descends.
6. **Toasts need a longer lifetime: 10 seconds for the default category** (currently 5 s for info, 2 s for debug-*). Apply at least to the debug-* categories — they're the bread-and-butter case. The aggregation behaviour stays as-is.
7. **Compile-cycle telemetry.** The pattern that fires on every keystroke is:
   - `compile-status running` (incoming WS frame)
   - one or more `pdf-segment` frames
   - `compile-status idle`
   When we receive `compile-status running` we start a timer. Each subsequent `pdf-segment` and `compile-status idle` toast in the same cycle should report its time delta from that start.
8. **`pdf-segment` toasts should include size in bytes and the page name.** E.g. the toast should read:
   ```
   1.7s — pdf-segment [3.out] 3652 bytes
   ```
9. **`compile-status idle` toasts should include the cycle elapsed time.** E.g.:
   ```
   4.6s — compile-status idle
   ```

These are all in the editor/toast code path. I think it could all be completed together in one iteration to be honest.
