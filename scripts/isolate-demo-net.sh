#!/bin/sh
# Block the demo container from the host LAN and other Docker networks.
# Allows outbound HTTP/HTTPS (map tiles, optional Coach) and DNS only.
# Run as root on the Docker host, and from cron @reboot.
#
#   sudo ./scripts/isolate-demo-net.sh

set -e
NET="172.30.99.0/24"
GW="172.30.99.1"
IFACE="br-gauges-demo"

iptables -N GAUGES-DEMO 2>/dev/null || iptables -F GAUGES-DEMO
iptables -C DOCKER-USER -j GAUGES-DEMO 2>/dev/null || iptables -I DOCKER-USER 1 -j GAUGES-DEMO

# Reply traffic for inbound Traefik → published port
iptables -A GAUGES-DEMO -s "$NET" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A GAUGES-DEMO -d "$NET" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

# No other RFC1918, no other Docker bridges, no cloud metadata
iptables -A GAUGES-DEMO -s "$NET" -d 10.0.0.0/8 -j DROP
iptables -A GAUGES-DEMO -s "$NET" -d 192.168.0.0/16 -j DROP
iptables -A GAUGES-DEMO -s "$NET" -d 169.254.0.0/16 -j DROP
iptables -A GAUGES-DEMO -s "$NET" -d "$NET" -j RETURN
iptables -A GAUGES-DEMO -s "$NET" -d 172.16.0.0/12 -j DROP

# Public web + DNS only
iptables -A GAUGES-DEMO -s "$NET" -p tcp --dport 443 -j RETURN
iptables -A GAUGES-DEMO -s "$NET" -p tcp --dport 80 -j RETURN
iptables -A GAUGES-DEMO -s "$NET" -p udp --dport 53 -j RETURN
iptables -A GAUGES-DEMO -s "$NET" -p tcp --dport 53 -j RETURN
iptables -A GAUGES-DEMO -s "$NET" -j DROP

# Do not let the demo hit services on this host (Portainer, Frigate, prod app, …)
iptables -C INPUT -s "$NET" -j DROP 2>/dev/null || iptables -I INPUT 1 -s "$NET" -j DROP
if ip link show "$IFACE" >/dev/null 2>&1; then
  iptables -C INPUT -i "$IFACE" -j DROP 2>/dev/null || iptables -I INPUT 1 -i "$IFACE" -j DROP
fi
# Gateway is the host on the demo bridge
iptables -C INPUT -d "$GW" -s "$NET" -j DROP 2>/dev/null || true

echo "gauges-demo net $NET isolated (HTTP/HTTPS/DNS egress only)"
