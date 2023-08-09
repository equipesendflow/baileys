import { Contact } from './Contact'

export type GroupParticipant = (Contact & { isAdmin?: boolean, isSuperAdmin?: boolean, admin?: 'admin' | 'superadmin' | null })

export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote'

export interface Community {
    /** Parent group of community */
    parent: boolean
    /** Incognito mode of community */
    incognito: boolean
    /** Allow non admin sub group creation of community */
    allowNonAdminSubGroupCreation: boolean
    /** Linked id of parent group community */
    linkedParentId?: string | undefined
    /** Membership approval mode of community */
    membershipApprovalMode?: string | undefined
    /** Default announcement group of community */
    default: boolean
}
export interface GroupMetadata {
    id: string
    owner: string | undefined
    subject: string
    /** group subject owner */
    subjectOwner?: string
    /** group subject modification date */
    subjectTime?: number
    creation?: number
    desc?: string
    descOwner?: string
    descId?: string
    community?: Community
    memberAddMode?: string
    /** is set when the group only allows admins to change group settings */
    restrict?: boolean
    /** is set when the group only allows admins to write messages */
    announce?: boolean
    /** number of group participants */
    size?: number
    // Baileys modified array
    participants: GroupParticipant[]
    ephemeralDuration?: number
    inviteCode?: string
}


export interface WAGroupCreateResponse {
    status: number
    gid?: string
    participants?: [{ [key: string]: {} }]
}

export interface GroupModificationResponse {
    status: number
    participants?: { [key: string]: {} }
}