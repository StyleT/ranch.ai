# Manual steps (Setup Assistant cannot be scripted without MDM)

Target: under 10 minutes hands-on. Take one screenshot per step for Post 0.

1. **Erase.** System Settings → General → Transfer or Reset → Erase All Content and Settings. Let it reinstall the current macOS.
2. **Setup Assistant.** Language and region. **Skip** Apple Account. Create admin user `ranch` with a real password (auto-login still works with one; store it in the password manager). **Skip** Siri, Apple Intelligence, analytics, Screen Time, Touch ID prompts.
3. **FileVault off.** It conflicts with any unattended boot path; the box holds nothing sensitive.
4. **Remote Login on.** System Settings → General → Sharing → Remote Login, administrators only. The one toggle that must happen locally; everything else arrives over SSH.
5. **Apple Intelligence & Siri off.** System Settings → Apple Intelligence & Siri → both off. No public `defaults` key confirmed, so this stays manual.
6. **Keyboard/mouse pairing tip.** If a Magic Keyboard will not pair at Setup Assistant, connect it with a USB-C cable for a few seconds.
7. No dummy HDMI plug: Apple Silicon minis create a 1920×1080 virtual display with no monitor attached. If a Screen Sharing session looks soft, use High Performance Screen Sharing or BetterDummy.

Then from the laptop:

```
make bootstrap    # Xcode CLT + Homebrew
make provision    # Ansible, run until a second run reports changed=0
make snapshot
sudo reboot       # on the mini, then:
make verify
```
