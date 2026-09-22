export const INF_ROLE_ID = "1513342427509952562";
// Shopper role in A7ix (shown as "Vics"); granted by the [role:shopper] button.
export const SHOPPER_ROLE_ID = "1513357951505535067";
// Individual users treated as staff no matter their roles.
export const ADMIN_USER_IDS = ["446137348904714241"];

export function isStaff(member) {
  return (member && (member.roles?.cache?.has(INF_ROLE_ID) || ADMIN_USER_IDS.includes(member.id))) ?? false;
}