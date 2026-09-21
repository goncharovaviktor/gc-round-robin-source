// EDIT THIS FILE IN GITHUB BEFORE DEPLOYMENT.
//
// `code` is the short value written to the GetCourse additional field
// `manager_code`. It must exactly match the branches in your GetCourse process.
// `name` is only a human-readable label for Cloudflare audit data.
// `active: false` temporarily removes a manager without deleting the row.
//
// IMPORTANT: after ANY later change to pools, order, codes, names or active flags,
// increase `version` by 1. Reusing the same version with different content is
// deliberately blocked so that a typo cannot silently replace the live setup.

export const MANAGER_CONFIG = Object.freeze({
  version: 1,
  pools: Object.freeze([
    {
      pool: "segment_1",
      initialLastManagerCode: "s1_manager_1",
      managers: [
        { code: "s1_manager_1", name: "Менеджер 1", active: true },
        { code: "s1_manager_2", name: "Менеджер 2", active: true },
        { code: "s1_manager_3", name: "Менеджер 3", active: true },
        { code: "s1_manager_4", name: "Менеджер 4", active: true },
        { code: "s1_manager_5", name: "Менеджер 5", active: true },
      ],
    },
    {
      pool: "segment_2",
      initialLastManagerCode: "s2_manager_3",
      managers: [
        { code: "s2_manager_1", name: "Менеджер 1", active: true },
        { code: "s2_manager_2", name: "Менеджер 2", active: true },
        { code: "s2_manager_3", name: "Менеджер 3", active: true },
        { code: "s2_manager_4", name: "Менеджер 4", active: true },
        { code: "s2_manager_5", name: "Менеджер 5", active: true },
      ],
    },
    {
      pool: "segment_3",
      initialLastManagerCode: "s3_manager_2",
      managers: [
        { code: "s3_manager_1", name: "Менеджер 1", active: true },
        { code: "s3_manager_2", name: "Менеджер 2", active: true },
        { code: "s3_manager_3", name: "Менеджер 3", active: true },
        { code: "s3_manager_4", name: "Менеджер 4", active: true },
        { code: "s3_manager_5", name: "Менеджер 5", active: true },
      ],
    },
    {
      pool: "segment_4",
      initialLastManagerCode: "s4_manager_3",
      managers: [
        { code: "s4_manager_1", name: "Менеджер 1", active: true },
        { code: "s4_manager_2", name: "Менеджер 2", active: true },
        { code: "s4_manager_3", name: "Менеджер 3", active: true },
        { code: "s4_manager_4", name: "Менеджер 4", active: true },
        { code: "s4_manager_5", name: "Менеджер 5", active: true },
      ],
    },
  ]),
});
