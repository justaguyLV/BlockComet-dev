# Changelog

## Unreleased

* Removed the Horizon (Rust) button from the main menu.
* Skins for local accounts: the launcher now writes the CustomSkinLoader configuration itself (own skin, then the shared
  BlockComet skin registry, then Mojang), applies the classic/slim model of the chosen skin, and removes a stale skin file when
  no skin is chosen any more.
* Skin service: a small Cloudflare Worker (folder `skins-worker/`, free plan) stores one PNG per player name; the launcher publishes
  the local player's skin there when a game starts (switch "Share my skin with other players", on by default) and every
  BlockComet player's game asks it for the skins of the other players. A name belongs to the first device that published it; that device can replace the skin or delete it (button "Delete my published skin" in the skin editor).
* The emulator test now also records a skin demo video (Local account, a typed name, the skin editor).

## 1.0.0 (first public release)

* Copper Launcher base with BlockComet name, icon and blue/white theme; in-app About page with licenses and source link.
* Ready-to-play "Meteor *version*" instances for Minecraft 1.20.1, 1.20.2, 1.20.4, 1.20.6, 1.21.1 and the newest versions the
  build can prepare, with the newest stable Fabric Loader, Fabric API, Meteor Client and performance mods.
* Color Studio (exact colors), background/surface styles, corner roundness, 20 preset fonts, import of any font file,
  Share my look (export/import), 46 selectable languages.
* Full Arabic interface: right-to-left layout, Tajawal font, 273 additional Arabic strings.
* Hotbar touch area matched to the real hotbar, with a diagnostic overlay; a tap on the slot touched last time is no longer
  ignored when the game changed the selected slot by itself. The in-game screen is always laid out left-to-right: in an
  Arabic (right-to-left) interface the hotbar touch area used to end up at the right edge of the screen.
