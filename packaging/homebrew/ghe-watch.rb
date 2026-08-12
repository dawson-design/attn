# Homebrew formula TEMPLATE for ghe-watch, versioned here as the source of
# truth. The release workflow (.github/workflows/release.yml) substitutes
# __URL__ and __SHA256__ with the tagged release tarball's values and pushes
# the result to kreek/homebrew-tap as Formula/ghe-watch.rb — do not edit the
# copy in the tap by hand.
class GheWatch < Formula
  desc "Local read-only GitHub notification dashboard with desktop notifications"
  homepage "https://github.com/kreek/ghe-notification-watch"
  url "__URL__"
  sha256 "__SHA256__"
  license "MIT"

  depends_on :macos
  depends_on "bun"
  depends_on "gh"

  def install
    libexec.install Dir["libexec/*"]
    (bin/"ghe-watch").write <<~SH
      #!/bin/bash
      export GHE_WATCH_HOME="#{opt_libexec}"
      export GHE_WATCH_BIN="#{opt_bin}/ghe-watch"
      exec "#{Formula["bun"].opt_bin}/bun" "#{opt_libexec}/cli.js" "$@"
    SH
    chmod 0755, bin/"ghe-watch"
  end

  # The backend LaunchAgent. The Chrome notification-window login item is a
  # second agent that brew services cannot manage; `ghe-watch init` offers it
  # (or run `ghe-watch install-window`). No host/port is baked in here: the app
  # reads ~/.config/ghe-watch/env at startup, so config changes only need
  # `brew services restart ghe-watch`.
  service do
    run [opt_bin/"ghe-watch", "serve"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    log_path var/"log/ghe-watch.log"
    error_log_path var/"log/ghe-watch.err.log"
  end

  def caveats
    <<~EOS
      Quick start:
        1. gh auth login --hostname <your-github-host>   (skip for github.com)
        2. ghe-watch init                                (writes ~/.config/ghe-watch/env)
        3. brew services start ghe-watch

      Dashboard: http://127.0.0.1:8765
      Desktop notifications need the Chrome window login item — `ghe-watch init`
      offers it, or run `ghe-watch install-window` / `ghe-watch open`.
    EOS
  end

  test do
    assert_match "Usage: ghe-watch", shell_output("#{bin}/ghe-watch --help")
  end
end
