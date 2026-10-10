import { redirect } from "next/navigation";

// There is no login screen: the workspace opens directly in the demo sandbox.
export default function LoginPage() {
  redirect("/");
}
