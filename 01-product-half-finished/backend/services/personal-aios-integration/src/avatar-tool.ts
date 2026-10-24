/** The profile service owns approved looks, CAS, persistence and publication. */
export interface AvatarProfileToolPort {
  read(principal: string): Promise<unknown | null>;
  looks(): readonly {look_id: string}[] | Promise<readonly {look_id: string}[]>;
  change(input: {principal_id: string; device_id: string; command_id: string; expected_version: number;
    look_id: string; owner_request: string}): Promise<unknown>;
}
