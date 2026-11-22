def short($n): gsub("\\s+"; " ") | .[0:$n];

fromjson?
| select(.type == "assistant")
| .message.content[]?
| if .type == "thinking" and ((.thinking // "") != "") then "THINK: " + (.thinking | short(600))
  elif .type == "text" and ((.text // "") != "") then "SAY: " + (.text | short(600))
  elif .type == "tool_use" then "RUN " + .name + ": " + (((.input.command // .input.file_path // .input.pattern // "") | tostring) | short(300))
  else empty end
