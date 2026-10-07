# Homebrew formula TEMPLATE for attn, versioned here as the source of
# truth. The release workflow (.github/workflows/release.yml) substitutes
# __URL__ and __SHA256__ with the tagged release tarball's values and pushes
# the result to dawson-design/homebrew-tap as Formula/attn.rb — do not edit the
# copy in the tap by hand.
class Attn < Formula
  desc "Dashboard of the GitHub pull requests and issues waiting on you"
  homepage "https://github.com/dawson-design/attn"
  url "__URL__"
  sha256 "__SHA256__"
  license "MIT"

  depends_on :macos
  depends_on "bun"
  depends_on "gh"

  def install
    libexec.install Dir["libexec/*"]
    (bin/"attn").write <<~SH
      #!/bin/bash
      export ATTN_HOME="#{opt_libexec}"
      export ATTN_BIN="#{opt_bin}/attn"
      exec "#{Formula["bun"].opt_bin}/bun" "#{opt_libexec}/cli.js" "$@"
    SH
    chmod 0755, bin/"attn"
  end

  # The backend LaunchAgent. The Chrome notification-window login item is a
  # second agent that brew services cannot manage; `attn init` offers it
  # (or run `attn install-window`). No host/port is baked in here: the app
  # reads ~/.config/attn/env at startup, so config changes only need
  # `brew services restart attn`.
  service do
    run [opt_bin/"attn", "serve"]
    keep_alive true
    environment_variables PATH: std_service_path_env
    log_path var/"log/attn.log"
    error_log_path var/"log/attn.err.log"
  end

  def caveats
    <<~EOS
      Quick start:
        1. gh auth login --hostname <your-github-host>   (skip for github.com)
        2. attn init                                (writes ~/.config/attn/env)
        3. brew services start attn

      Dashboard: attn open   (signs the browser in; http://127.0.0.1:8765)
      Desktop notifications need the Chrome window login item — `attn init`
      offers it, or run `attn install-window` / `attn open`.

      Claude Code: /plugin marketplace add dawson-design/attn, then /plugin install attn@attn
      Claude Desktop: attn setup claude-desktop
    EOS
  end

  test do
    assert_match "Usage: attn", shell_output("#{bin}/attn --help")
  end
end
