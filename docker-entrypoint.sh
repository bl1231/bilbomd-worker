#!/bin/sh
set -e

# Inject dynamic user into /etc/passwd if needed
if ! getent passwd "$(id -u)" > /dev/null; then
  echo "appuser:x:$(id -u):$(id -g):App User:/home/app:/bin/sh" >> /etc/passwd
fi

# Now run the real app (default to passed args, or npm start)
exec "$@"