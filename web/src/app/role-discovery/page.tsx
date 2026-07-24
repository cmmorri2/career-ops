import { RoleDiscoveryView } from "@/components/role-discovery-view";
import { readRoleDiscovery } from "@/lib/career-ops";

export const dynamic = "force-dynamic";

export default function RoleDiscoveryPage() {
  return <RoleDiscoveryView clusters={readRoleDiscovery()} />;
}
