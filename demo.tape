# Reproducible demo recording for the README.
# Run from a scratch project so the recorded paths do not expose a home directory:
#   mkdir -p /tmp/oc-demo/.opencode
#   printf '{"plugin":["/Users/gaosper/Documents/opencode-tui-stats"]}' > /tmp/oc-demo/.opencode/tui.json
#   cd /tmp/oc-demo && vhs /Users/gaosper/Documents/opencode-tui-stats/demo.tape
#
# The prompt spawns subagents backed by *different* models, so the panel shows several
# distinct `↳` rows instead of merging them into one. Trim afterwards, e.g.:
#   ffmpeg -ss <start> -t <len> -i demo-new.gif \
#     -vf "fps=12.5,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse" out.gif
Output demo-new.gif

Set Shell "zsh"
Set FontSize 16
Set Width 1600
Set Height 900
Set Padding 12
Set Theme "Dracula"
Set Framerate 20
Set TypingSpeed 30ms
Set CursorBlink false

Sleep 2s
Type "opencode"
Enter
Sleep 10s
Type "Ask @oracle and @writer_doc to each explain TPS in one line."
Sleep 1s
Enter
Sleep 60s
Sleep 2s
