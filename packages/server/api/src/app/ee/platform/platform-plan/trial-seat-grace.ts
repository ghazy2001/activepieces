import { isNil, tryCatch } from '@activepieces/core-utils'
import { apDayjs } from '@activepieces/server-utils'
import { InvitationStatus, PlatformPlan, SelfServeTrialWindow, TrialSeatGrace, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import { JobsOptions } from 'bullmq'
import dayjs, { Dayjs } from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In, SelectQueryBuilder } from 'typeorm'
import { transaction } from '../../../core/db/transaction'
import { rejectedPromiseHandler } from '../../../helper/promise-handler'
import { billingProvider } from '../../../platform/billing-provider'
import { UserSchema } from '../../../user/user-entity'
import { excludeEmbeddedUsers, userRepo } from '../../../user/user-service'
import { getInvitationExpiryCutoff, userInvitationsService } from '../../../user-invitations/user-invitation.service'
import { platformPlanTelemetry } from './platform-plan-telemetry'
import { platformPlanRepo } from './platform-plan.service'
import { selfServeTrialWindow } from './self-serve-trial-window'

const SEAT_GRACE_DAYS = 7
const SWEEP_HOUR_UTC = 15
const SWEEP_MINUTE_UTC = 30
const SWEEP_CATCH_UP_DAYS = 3

export const trialSeatGrace = (log: FastifyBaseLogger) => ({
    async get({ plan }: GetParams): Promise<TrialSeatGrace | null> {
        const window = (await selfServeTrialWindow.read(plan.platformId))?.window ?? null
        if (isNil(window) || !graceRunning(window)) {
            return null
        }
        return findSeatsOverPlan({ platformId: plan.platformId, seatLimit: plan.usersLimit, window, billingEnforced: true, log })
    },
    async endsAt({ platformId, window }: EndsAtParams): Promise<string | null> {
        if (!graceRunning(window)) {
            return null
        }
        const plan = await platformPlanRepo().findOneBy({ platformId })
        const grace = await findSeatsOverPlan({ platformId, seatLimit: plan?.usersLimit, window, billingEnforced: true, log })
        return isNil(grace) ? null : graceDeadline(window).toISOString()
    },
    async sweep(): Promise<void> {
        const today = apDayjs().utc().startOf('day')
        const failedPlatformIds: string[] = []
        for (const platformId of await findPlatformsOverTheirSeats()) {
            const { error } = await tryCatch(() => endGraceIfDue({ platformId, today, log }))
            if (!isNil(error)) {
                log.error({ error, platform: { id: platformId } }, 'Failed to end the seat grace')
                failedPlatformIds.push(platformId)
            }
        }
        if (failedPlatformIds.length > 0) {
            throw new Error(`Failed to end the seat grace for ${failedPlatformIds.length} platform(s); the sweep job retries them`)
        }
    },
})

async function endGraceIfDue({ platformId, today, log }: EndGraceIfDueParams): Promise<void> {
    const window = await trialWindowFor({ platformId, log })
    if (isNil(window) || !graceDueOn({ window, today })) {
        return
    }
    await deactivateUsersOverPlan({ platformId, window, log })
}

async function trialWindowFor({ platformId, log }: PlatformLogParams): Promise<SelfServeTrialWindow | null> {
    const cached = await selfServeTrialWindow.read(platformId)
    if (!isNil(cached)) {
        return cached.window
    }
    await billingProvider.get(log).refreshEntitlements(platformId)
    return (await selfServeTrialWindow.read(platformId))?.window ?? null
}

async function deactivateUsersOverPlan({ platformId, window, log }: DeactivateUsersOverPlanParams): Promise<void> {
    await billingProvider.get(log).refreshEntitlements(platformId)
    const billingEnforced = await billingProvider.get(log).isBillingEnforced(platformId)
    const deactivated = await transaction(async (entityManager) => {
        const plan = await platformPlanRepo(entityManager)
            .createQueryBuilder('platform_plan')
            .setLock('pessimistic_write')
            .where('platform_plan.platformId = :platformId', { platformId })
            .getOneOrFail()
        await activeUsers({ platformId, entityManager }).setLock('pessimistic_write').select('user.id').getMany()
        const grace = await findSeatsOverPlan({ platformId, seatLimit: plan.usersLimit, window, billingEnforced, log, entityManager })
        const userIds = grace?.userIds ?? []
        if (userIds.length > 0) {
            await userRepo(entityManager).update({ id: In(userIds), platformId }, { status: UserStatus.INACTIVE })
        }
        return userIds.length
    })
    if (deactivated > 0) {
        rejectedPromiseHandler(platformPlanTelemetry(log).onTrialSeatsDeactivated({ platformId, deactivatedUsers: deactivated }), log)
    }
    log.info({ platform: { id: platformId }, seatGrace: { deactivatedCount: deactivated } }, 'Seat grace ended')
}

async function findPlatformsOverTheirSeats(): Promise<string[]> {
    const rows = await platformPlanRepo()
        .createQueryBuilder('platform_plan')
        .select('platform_plan.platformId', 'platformId')
        .innerJoin(`(${ACTIVE_NON_EMBEDDED_USERS_PER_PLATFORM})`, 'active_users', 'active_users."platformId" = platform_plan."platformId"')
        .leftJoin(`(${SEAT_RESERVING_INVITES_PER_PLATFORM})`, 'invites', 'invites."platformId" = platform_plan."platformId"')
        .where('platform_plan.usersLimit IS NOT NULL')
        .andWhere('active_users.seats + COALESCE(invites.seats, 0) > platform_plan."usersLimit"')
        .setParameters({
            active: UserStatus.ACTIVE,
            embedded: UserIdentityProvider.JWT,
            reserving: [InvitationStatus.PENDING, InvitationStatus.ACCEPTED],
            expiryCutoff: getInvitationExpiryCutoff(),
        })
        .getRawMany<{ platformId: string }>()
    return rows.map((row) => row.platformId)
}

async function findSeatsOverPlan({ platformId, seatLimit, window, billingEnforced, log, entityManager }: FindSeatsOverPlanParams): Promise<TrialSeatGrace | null> {
    if (!billingEnforced || isNil(seatLimit)) {
        return null
    }
    const [activeUserCount, invitedSeats] = await Promise.all([
        excludeEmbeddedUsers(activeUsers({ platformId, entityManager })).getCount(),
        userInvitationsService(log).countReservedSeats({ platformId, entityManager }),
    ])
    const usedSeats = activeUserCount + invitedSeats
    const seatsOver = usedSeats - seatLimit
    if (seatsOver <= 0) {
        return null
    }
    const newestAdded = await excludeEmbeddedUsers(activeUsers({ platformId, entityManager }))
        .andWhere('user.created >= :addedSince', { addedSince: dayjs(window.startedAt).toISOString() })
        .andWhere('user.created <= :addedBefore', { addedBefore: dayjs(window.endsAt).toISOString() })
        .andWhere(USER_IS_NOT_THE_PLATFORM_OWNER)
        .orderBy('user.created', 'DESC')
        .limit(seatsOver)
        .getMany()
    if (newestAdded.length === 0) {
        return null
    }
    return { usedSeats, seatLimit, userIds: newestAdded.map((user) => user.id) }
}

function graceDeadline(window: SelfServeTrialWindow): Dayjs {
    return firstSweepFrom(dayjs(window.endsAt).add(SEAT_GRACE_DAYS, 'day'))
}

function graceRunning(window: SelfServeTrialWindow): boolean {
    const now = dayjs()
    return !dayjs(window.endsAt).isAfter(now) && graceDeadline(window).isAfter(now)
}

function graceDueOn({ window, today }: GraceDueOnParams): boolean {
    const deadlineDay = graceDeadline(window).utc().startOf('day')
    return !deadlineDay.isAfter(today) && today.diff(deadlineDay, 'day') <= SWEEP_CATCH_UP_DAYS
}

function firstSweepFrom(moment: Dayjs): Dayjs {
    const sameDaySweep = moment.utc().hour(SWEEP_HOUR_UTC).minute(SWEEP_MINUTE_UTC).second(0).millisecond(0)
    return sameDaySweep.isBefore(moment) ? sameDaySweep.add(1, 'day') : sameDaySweep
}

function activeUsers({ platformId, entityManager }: ActiveUsersParams): SelectQueryBuilder<UserSchema> {
    return userRepo(entityManager)
        .createQueryBuilder('user')
        .where('user.platformId = :platformId', { platformId })
        .andWhere('user.status = :status', { status: UserStatus.ACTIVE })
}

const USER_IS_NOT_THE_PLATFORM_OWNER = `NOT EXISTS (
    SELECT 1
    FROM platform
    WHERE platform.id = "user"."platformId"
    AND platform."ownerId" = "user".id
)`

const ACTIVE_NON_EMBEDDED_USERS_PER_PLATFORM = `SELECT "user"."platformId", COUNT(*) AS seats
    FROM "user"
    WHERE "user".status = :active
    AND NOT EXISTS (
        SELECT 1
        FROM user_identity identity
        WHERE identity.id = "user"."identityId"
        AND identity.provider = :embedded
    )
    GROUP BY "user"."platformId"`

const SEAT_RESERVING_INVITES_PER_PLATFORM = `SELECT invitation."platformId", COUNT(*) AS seats
    FROM user_invitation invitation
    WHERE invitation.status IN (:...reserving)
    AND invitation.updated > :expiryCutoff
    GROUP BY invitation."platformId"`

type GetParams = {
    plan: PlatformPlan
}

type EndsAtParams = {
    platformId: string
    window: SelfServeTrialWindow
}

type PlatformLogParams = {
    platformId: string
    log: FastifyBaseLogger
}

type EndGraceIfDueParams = PlatformLogParams & {
    today: Dayjs
}

type DeactivateUsersOverPlanParams = PlatformLogParams & {
    window: SelfServeTrialWindow
}

type GraceDueOnParams = {
    window: SelfServeTrialWindow
    today: Dayjs
}

type FindSeatsOverPlanParams = {
    platformId: string
    seatLimit: number | null | undefined
    window: SelfServeTrialWindow
    billingEnforced: boolean
    log: FastifyBaseLogger
    entityManager?: EntityManager
}

type ActiveUsersParams = {
    platformId: string
    entityManager?: EntityManager
}

export const TRIAL_SEAT_GRACE_SWEEP_CRON = `${SWEEP_MINUTE_UTC} ${SWEEP_HOUR_UTC} * * *`

export const TRIAL_SEAT_GRACE_SWEEP_RETRY: JobsOptions = {
    attempts: 6,
    backoff: { type: 'fixed', delay: 60 * 60 * 1000 },
}
