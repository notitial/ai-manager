---
description: "Turn the Mac's screen and keyboard backlight off right now, without sleeping the Mac. No arguments. Runs exactly `pmset displaysleepnow`. Use on '/lights-out'."
disable-model-invocation: true
---

# Lights out

Turns the display off (and with it the keyboard backlight) at once. It does not put the Mac to sleep: running
sessions, builds and a `/keep-awake` hold carry on.

No argument is accepted. If the user typed one, refuse and say so; do not pass it on.

## Run

Run exactly this, as an ordinary Bash call, with nothing before it, nothing after it and no flag:

```
pmset displaysleepnow
```

It prints nothing and exits 0. There is nothing to verify; the screen going dark is the result. Say "Display off."
in one line and nothing more.

## What the user should know

- **Waking:** any key press or trackpad touch turns the display back on.
- **Locking:** if System Settings > Lock Screen has "Require password after screen saver begins or display is
  turned off" set to "Immediately", waking shows the lock screen and needs the password. With a longer delay it
  does not.
- **Sleep:** this only darkens the display. The Mac itself sleeps only on its own idle timer, and a running
  `caffeinate` hold (see `/keep-awake`) keeps it awake as before. Closing the lid without an external display
  still puts the Mac to sleep, whatever this does.
- **Remote or other machines:** this acts on the machine the session runs on; nothing is sent elsewhere.

## Permissions

`pmset displaysleepnow` only changes the display's power state. It needs no root and changes no setting.
No `permissions.ask` rule covers it: the skill is typed by the user only (`disable-model-invocation`), and in
auto mode the command reviewer judges the call like any other.

The toolkit's workspace-lock guard passes exactly this command: its exact-read list has `pmset displaysleepnow`
beside `pmset -g assertions`, matched on the two words. Any other `pmset` form, an extra word, a prefix, a
trailer, a chained command or a redirect to a real file is denied as before. This lets MANAGER, which holds
no lock in a lock-armed checkout, run it when the user types `/lights-out`. The same list opens it to every
session without the lock in a lock-armed workspace; it touches nothing in the working copy. The toolkit's
guard tests cover this form.
