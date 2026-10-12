import type { OrderStatus } from "../hooks/useOrders";

type Channel = "all" | "branch" | "online";

type Props = {
  status: OrderStatus | "all";
  channel: Channel;
  onStatusChange: (status: OrderStatus | "all") => void;
  onChannelChange: (channel: Channel) => void;
};

export function StatusFilterBar({ status, channel, onStatusChange, onChannelChange }: Props) {
  return (
    <div>
      <select value={status} onChange={(event) => onStatusChange(event.target.value as OrderStatus | "all")}>
        <option value="all">All statuses</option>
        <option value="open">Open</option>
        <option value="shipped">Shipped</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <label>
        <input type="radio" checked={channel === "all"} onChange={() => onChannelChange("all")} />
        All channels
      </label>
      <label>
        <input type="radio" checked={channel === "branch"} onChange={() => onChannelChange("branch")} />
        Branch
      </label>
      <label>
        <input type="radio" checked={channel === "online"} onChange={() => onChannelChange("online")} />
        Online
      </label>
    </div>
  );
}
