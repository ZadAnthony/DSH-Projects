# Project work tools

`runtime.ts` installs `project-work-tools.ts` on the actual main/execution work scope. `project_rename` is registered only for main; `project_usage` is registered for both. Neither tool is registered for the Memory Bot or session manager.

The shared installers also receive the actual work role: only main registers `project_create_session`, the three overview writes and `project_stop_execution`. Execution retains its legitimate read, communication, work, settings and schedule tools. These five main-only names are absent from execution's actual model Schemas and PTC SDK/bindings; the original execution-time owner guards remain in place.

`project_rename` accepts only `name` and `expected_revision`. The live caller check and accepted Project operation precede the existing `ProjectStore.updateProject` call. A stale revision returns the current Project without overwriting it. The UI and work tool use the same Store.

`project_usage` binds the Project from the real caller and passes optional logical-session, model and `[from,to)` millisecond filters to the existing usage service. It returns that owner's known, partial, missing, unknown and cost information without a second accumulator, model call or configuration change.

The shared `project_history` Schema describes `recorded` as native event append/record time. It does not substitute for an unavailable original producer occurrence time.

`project_read` without a selector retains the Project/membership/board and legacy delivery directory response. Exact v2 receipts use one original `operation_ref`, or one real incoming `project-delivery.deliveryId` as `delivery_id`. Receipt and native source selectors cannot be mixed. Reading never resends a communication, and a transport receipt does not prove work completion.

`project-request-context.ts` labels readable saved instructions as literal saved text. Unavailable settings remain system read status with their actual Project/session scope; they do not clear the saved value or revive an earlier projection.

The complete Project and session supplement sections follow the fixed role/tool guidance and PTC SDK (`TOOLS_SDK + 1/+2`), with Project before session. Their names, scopes, literal contents and per-request fresh reads remain unchanged. Later native output/host sections retain their order; this is not an absolute end-of-system placement or a change in instruction authority. Current-block positions and ordinary message/tool history are unchanged.

The private stock graph withdraws Goal when materializing the selected preset in `stock/presets/loader.ts`: Goal service, round driver, tool and command declarations are disabled in the runnable copy. `stock/presets/native-foundations.ts` also excludes the root Goal provider. Ordinary DSH keeps its own Goal service and tools; saved Goal records remain historical sources.

`project-read-evidence.ts` compacts only the approved equivalent plain-text historical representation. Bot Memory pages retain partial range evidence and are never complete Memory read acknowledgements. A stale revision/scope, withdrawn/missing entry or unreadable current owner removes the old current page from the next supplied history; the durable original remains unchanged.
