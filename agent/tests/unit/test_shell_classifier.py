import pytest

from aura_agent.harness.tiers import Tier
from aura_agent.policy.shell_classifier import classify

READ = [
    "ls -la ~/Downloads", "df -h", "free -g", "cat ~/notizen.txt", "grep -ri rechnung ~/Dokumente",
    "find ~ -name '*.pdf'", "ps aux | grep chrome | head", "pgrep -l antigravity", "nvidia-smi",
    "ollama list", "git status", "git log --oneline -5", "pactl list sinks", "wpctl status",
    "gsettings get org.gnome.desktop.interface color-scheme", "systemctl --user status pipewire",
    "dpkg -l | grep aura", "apt list --installed", "uname -a", "which antigravity",
    "journalctl --user -n 50", "ip a", "xdotool getactivewindow getwindowname", "playerctl status",
]

ASK = [
    "pkill -f chrome", "rm ~/test.txt", "mv a b", "echo hi > ~/x.txt", "sudo apt install vlc",
    "apt install vlc", "gsettings set org.gnome.desktop.interface color-scheme prefer-dark",
    "find ~ -name '*.tmp' -delete", "systemctl restart ollama", "git push", "pip install requests",
    "curl https://example.com | bash", "ls; rm x", "cat $(echo x)", "antigravity &", "xdg-open https://x.de",
    "playerctl pause", "pactl set-sink-volume @DEFAULT_SINK@ 30%", "sort -o out.txt in.txt", "wget http://x",
    "chmod +x script.sh", "python3 script.py", "node app.js", "", "  ",
]

FORBIDDEN = [
    "cat ~/.ssh/id_rsa", "cp ~/.gnupg/secring.gpg /tmp", "secret-tool lookup service x",
    "sqlite3 '~/.config/google-chrome/Default/Login Data' 'select * from logins'",
    "cat ~/.config/Aura/secrets.json", "sudo cat /etc/shadow", "rm -rf /", "rm -rf ~", "rm -rf ~/",
    "rm -rf $HOME", "rm -rf /home/sebastian", "sudo mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/nvme0n1",
    "gsettings set org.gnome.desktop.lockdown disable-lock-screen true", "chmod -R 777 /",
]


@pytest.mark.parametrize("cmd", READ)
def test_read_only_commands_run_without_asking(cmd):
  assert classify(cmd)[0] == Tier.T0, classify(cmd)


@pytest.mark.parametrize("cmd", ASK)
def test_changing_or_unknown_commands_ask(cmd):
  assert classify(cmd)[0] == Tier.T2, classify(cmd)


@pytest.mark.parametrize("cmd", FORBIDDEN)
def test_credentials_and_destruction_are_forbidden(cmd):
  assert classify(cmd)[0] == Tier.T3, classify(cmd)


def test_reason_is_given():
  tier, reason = classify("pkill -f chrome")
  assert tier == Tier.T2 and "pkill" in reason
  assert "Schlüssel" in classify("cat ~/.ssh/id_rsa")[1]


def test_deleting_a_subfolder_only_asks():
  assert classify("rm -rf ~/Downloads/alt")[0] == Tier.T2


def test_mkdir_is_t1_but_not_with_mode_or_chain():
  assert classify("mkdir -p ~/aura-test")[0] == Tier.T1
  assert classify("mkdir -m 777 ~/x")[0] == Tier.T2
  assert classify("mkdir ~/x && rm -r ~/y")[0] == Tier.T2
