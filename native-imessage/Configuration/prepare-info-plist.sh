set -euo pipefail
cp "$SCRIPT_INPUT_FILE_0" "$SCRIPT_OUTPUT_FILE_0"
if [[ "$CONFIGURATION" == "QA" && "$PLATFORM_NAME" == "iphonesimulator" ]]; then
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$SCRIPT_OUTPUT_FILE_0"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$SCRIPT_OUTPUT_FILE_0"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains dict" "$SCRIPT_OUTPUT_FILE_0"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains:127.0.0.1 dict" "$SCRIPT_OUTPUT_FILE_0"
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSExceptionDomains:127.0.0.1:NSExceptionAllowsInsecureHTTPLoads bool true" "$SCRIPT_OUTPUT_FILE_0"
fi
