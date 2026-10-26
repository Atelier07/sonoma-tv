#!/bin/sh
# start-airplay.sh - bring up shairport-sync (AirPlay receiver) on webOS from the Entware
# tree WITHOUT a chroot. "/" is a read-only overlay so we cannot create the usual /opt
# symlink, so we invoke the Entware dynamic loader explicitly and point ALSA at the
# Entware alsa config. It runs in the host namespaces, so it uses the TV's already-running
# dbus + avahi to advertise _raop._tcp / _airplay._tcp on the LAN.
E=/var/lib/webosbrew/entware
L=$E/opt/lib
export ALSA_CONFIG_PATH=$E/opt/share/alsa/alsa.conf
# libdbus' default system-bus path is not where this TV's bus sends avahi, so point it
# explicitly; without this shairport dies with "avahi client: Daemon not running".
export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/var/run/dbus/system_bus_socket"
mkdir -p /var/run/shairport-sync 2>/dev/null
exec "$L/ld-linux.so.3" --library-path "$L" \
     "$E/opt/bin/shairport-sync" -c "$E/opt/etc/shairport-sync.conf" "$@"
