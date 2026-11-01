/**
 * How a file belongs to a trip, in the details pane: joined on exact
 * evidence, added by the owner, or matched only by its date and waiting
 * for a yes. Leaving and joining are one press each.
 */

import { joinablePlans } from "../intel/agendarows";
import { isTripTag, tripTitle } from "../intel/trips";
import { useStore, type FileEntry } from "../store";
import { useTripPlans } from "./useTripPlans";
import { Button } from "./ui/button";

export function TripSection(props: { file: FileEntry; onToast(text: string): void }) {
  const { file } = props;
  const files = useStore((s) => s.files);
  const leaveTrip = useStore((s) => s.leaveTrip);
  const addToTrip = useStore((s) => s.addToTrip);
  const { plans, dismissed, excluded } = useTripPlans();

  const tag = file.tags.find(isTripTag);
  const nameOf = (tripTag: string) =>
    plans.find((plan) => plan.tag === tripTag)?.destination ?? tripTitle(tripTag).split(",")[0]!;

  if (tag) {
    const name = nameOf(tag);
    const exact = plans.find((plan) => plan.tag === tag)?.exact.has(file.id) ?? false;
    return (
      <div className="details-trip">
        <span className="details-label">Trip</span>
        <div className="details-trip-body">
          <div>
            Part of <b>{name}</b> {exact && <span className="tln-evb tln-evb-exact">EXACT</span>}
          </div>
          <div className="details-trip-why">
            {exact ? "Exact evidence, so it joined the trip on its own." : "You added it to this trip."}
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void leaveTrip([file.id], tag);
              props.onToast(`Removed from ${name}. Every device hears it.`);
            }}
          >
            Not part of this trip
          </Button>
        </div>
      </div>
    );
  }

  const plan = joinablePlans(plans, dismissed, (id, tripTag) => files.get(id)?.tags.includes(tripTag) ?? false).find(
    (candidate) => candidate.weak.includes(file.id) && !excluded.has(`${candidate.tag}|${file.id}`),
  );
  if (!plan) {
    return null;
  }
  const name = plan.destination ?? nameOf(plan.tag);
  return (
    <div className="details-trip">
      <span className="details-label">Trip</span>
      <div className="details-trip-body">
        <div>
          Not in a trip yet <span className="tln-evb tln-evb-weak">DATE ONLY</span>
        </div>
        <div className="details-trip-why">Only the date matches, so Engram asks before linking it.</div>
        <Button
          size="xs"
          onClick={() => {
            void addToTrip([file.id], plan.tag);
            props.onToast(`Added to ${name}. The trip total is updated.`);
          }}
        >
          Add to {name}
        </Button>
      </div>
    </div>
  );
}
