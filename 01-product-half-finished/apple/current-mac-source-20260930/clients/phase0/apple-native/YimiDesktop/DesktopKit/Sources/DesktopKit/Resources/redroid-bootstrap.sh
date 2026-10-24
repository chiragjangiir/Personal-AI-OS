#!/bin/sh
# Bootstrap only. Normal starts use the retained kernel, container and data volume.
set -eu
export DEBIAN_FRONTEND=noninteractive
if [ "${1:-prepare}" = prepare ]; then
apt-get update
apt-get install -y --no-install-recommends ca-certificates gzip kmod initramfs-tools
# APT authenticates each repository and verifies package SHA-256 before unpacking.
cat > /etc/apt/sources.list.d/yimi-redroid-kernel.sources <<'SOURCES'
Types: deb
URIs: https://ports.ubuntu.com/ubuntu-ports
Suites: jammy-security jammy-updates
Components: main
Architectures: arm64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
cat > /etc/apt/sources.list.d/yimi-redroid-runtime.sources <<'SOURCES'
Types: deb
URIs: https://ports.ubuntu.com/ubuntu-ports
Suites: noble-updates noble-security
Components: main universe
Architectures: arm64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SOURCES
apt-get update
apt-get install -y --no-install-recommends \
  linux-image-5.15.0-198-generic=5.15.0-198.208 \
  linux-modules-5.15.0-198-generic=5.15.0-198.208 \
  linux-modules-extra-5.15.0-198-generic=5.15.0-198.208 \
  docker.io=29.1.3-0ubuntu3~24.04.2 \
  containerd=2.2.1-0ubuntu1~24.04.3 \
  runc=1.3.4-0ubuntu1~24.04.1
apt-mark hold linux-image-5.15.0-198-generic linux-modules-5.15.0-198-generic \
  linux-modules-extra-5.15.0-198-generic docker.io containerd runc
# Native arm64 Ubuntu vmlinuz is gzip-compressed; VZ needs the decompressed Image.
gzip -dc /boot/vmlinuz-5.15.0-198-generic > /tmp/yimi-redroid-kernel
mkinitramfs -o /boot/initrd.img-5.15.0-198-generic 5.15.0-198-generic
cp /boot/initrd.img-5.15.0-198-generic /tmp/yimi-redroid-initrd
root_device=$(findmnt -n -o SOURCE /)
root_uuid=$(blkid -s PARTUUID -o value "$root_device")
test -n "$root_uuid"
printf 'root=PARTUUID=%s ro console=tty1 console=ttyAMA0\n' "$root_uuid" > /tmp/yimi-redroid-cmdline
chmod 0644 /tmp/yimi-redroid-kernel /tmp/yimi-redroid-initrd /tmp/yimi-redroid-cmdline
mkdir -p /dev/binderfs /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/redroid-modules.service <<'UNIT'
[Unit]
Description=Redroid binder and native ashmem modules
DefaultDependencies=no
Before=dev-binderfs.mount
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/modprobe binder_linux devices=binder,hwbinder,vndbinder
ExecStart=/sbin/modprobe ashmem_linux
UNIT
cat > /etc/systemd/system/dev-binderfs.mount <<'UNIT'
[Unit]
Description=Redroid binderfs
Requires=redroid-modules.service
After=redroid-modules.service
Before=redroid-devices.service docker.service
[Mount]
What=binder
Where=/dev/binderfs
Type=binder
[Install]
WantedBy=local-fs.target
UNIT
cat > /etc/systemd/system/redroid-devices.service <<'UNIT'
[Unit]
Description=Redroid binder and ashmem device permissions
Requires=redroid-modules.service dev-binderfs.mount
After=redroid-modules.service dev-binderfs.mount
Before=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/chmod 0666 /dev/binderfs/binder /dev/binderfs/hwbinder /dev/binderfs/vndbinder /dev/ashmem
UNIT
cat > /etc/systemd/system/docker.service.d/redroid.conf <<'UNIT'
[Unit]
Requires=redroid-devices.service
After=redroid-devices.service
UNIT
cat > /usr/local/sbin/redroid-stop <<'SCRIPT'
#!/bin/sh
set -eu
[ "$(docker inspect -f '{{.State.Running}}' redroid)" = true ] || exit 0
docker exec redroid setprop sys.powerctl shutdown
docker stop --time 45 redroid
SCRIPT
chmod 0755 /usr/local/sbin/redroid-stop
cat > /etc/systemd/system/redroid.service <<'UNIT'
[Unit]
Description=Persistent Redroid Android container
Requires=docker.service redroid-devices.service
After=docker.service redroid-devices.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/docker start redroid
ExecStop=/usr/local/sbin/redroid-stop
TimeoutStopSec=55
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable dev-binderfs.mount redroid.service
exit 0
fi
# Device nodes exist only after the direct 5.15 boot.
test "$(uname -r)" = 5.15.0-198-generic
if [ -n "${2:-}" ]; then
  mkdir -p /etc/docker
  printf '%s\n' "$2" > /etc/docker/daemon.json
  systemctl restart docker.service
else
  systemctl start docker.service
fi
# Docker verifies the pinned manifest and each content-addressed compressed blob.
image=redroid/redroid:13.0.0_64only-latest@sha256:c815ac1b1d5bd0a099b74c3e3e0eeea3b32bed8d7ab1f788c20fb74e35891716
docker pull "$image"
if ! docker container inspect redroid >/dev/null 2>&1; then
  docker create --name redroid --privileged --restart=unless-stopped \
    --mount type=bind,src=/dev/binderfs/binder,dst=/dev/binder \
    --mount type=bind,src=/dev/binderfs/hwbinder,dst=/dev/hwbinder \
    --mount type=bind,src=/dev/binderfs/vndbinder,dst=/dev/vndbinder \
    --mount type=bind,src=/dev/ashmem,dst=/dev/ashmem \
    -v redroid-data:/data -p 127.0.0.1:5555:5555 "$image" \
    androidboot.use_memfd=0 androidboot.redroid_gpu_mode=guest \
    androidboot.redroid_width=720 androidboot.redroid_height=1280 \
    androidboot.redroid_fps=15 androidboot.redroid_dpi=320 \
    androidboot.redroid_net_ndns=2 androidboot.redroid_net_dns1=223.5.5.5 \
    androidboot.redroid_net_dns2=119.29.29.29
fi
if [ -n "${2:-}" ]; then
  rm /etc/docker/daemon.json
  systemctl restart docker.service
fi
systemctl start redroid.service
