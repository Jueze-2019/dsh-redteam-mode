#!/bin/bash
PORT=$1; shift
for c in "$@"; do
  u=${c%%:*}; p=${c#*:}
  [ "$u" = "$c" ] && p=""
  r=$(timeout 25 mysql -h 127.0.0.1 -P $PORT -u "$u" ${p:+-p"$p"} --connect-timeout=12 -N -e "select concat('AUTHOK ',version(),' ',current_user());" 2>&1 | tail -1)
  echo "$u / $p => $r"
done
