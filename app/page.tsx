import { redirect } from "next/navigation";

/** The app opens on the market list. There is nothing to see before it. */
export default function HomePage() {
  redirect("/markets");
}
