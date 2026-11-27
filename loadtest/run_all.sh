#!/bin/bash
# Full platform E2E: every suite against a FRESH server + empty data dir (port 3951, throwaway copy).
# Usage: cd <throwaway copy of the project> && bash loadtest/run_all.sh
PORT=3951
OUT=${OUT:-/tmp/fullrun}
mkdir -p $OUT; : > $OUT/summary.txt
SUITES="platform_e2e:N=300 registration_open_e2e waitlist_whatsapp_e2e exclusive_code_e2e event_heads_e2e event_merge_e2e partner_e2e members_admin_e2e member_details_e2e birthdate_request_e2e birthday_e2e birthday_video_e2e committee_whatsapp_e2e dashboard_cards_e2e custom_report_e2e reports_e2e awards_e2e tournament_e2e swiss_e2e league_e2e ps_ko64_e2e ps_ko64_b_e2e simulation_e2e player_scores_e2e tournaments_matrix_e2e registration_confirm_ui_e2e whatsapp_event_info_ui_e2e court_balance_e2e court_chart_ui_e2e schedule_print_e2e score_concurrency_e2e backup_restore_e2e backup_restore_ui_e2e gate_cancel_and_attendance_confirm_ui_e2e simulation_ui_e2e runner_ui_e2e player_scores_ui_e2e tournament_1000_e2e"
for entry in $SUITES; do
  name=${entry%%:*}; extra=""; [[ "$entry" == *:* ]] && extra=${entry#*:}
  pkill -f "node server.js" 2>/dev/null; sleep 1
  rm -rf data; mkdir -p data
  (ADMIN_BOOTSTRAP_USERNAME=e2eadmin ADMIN_BOOTSTRAP_PASSWORD='E2ETest!2026xyz' PORT=$PORT nohup node server.js > $OUT/server_$name.log 2>&1 &)
  sleep 3
  start=$(date +%s)
  env BASE_URL=http://localhost:$PORT $extra timeout 900 node loadtest/$name.js > $OUT/$name.log 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))
  res=$(grep -Eio "[0-9]+ passed,? *[0-9]* *failed|passed [0-9]+ failed [0-9]+|[0-9]+ pass(ed)? */ *[0-9]+ fail" $OUT/$name.log | tail -1)
  fives=$(grep -c " 5[0-9][0-9]" $OUT/server_$name.log)
  echo "$name | exit=$code | ${secs}s | ${res:-no-summary-line}" >> $OUT/summary.txt
done
pkill -f "node server.js" 2>/dev/null
echo FINISHED >> $OUT/summary.txt
