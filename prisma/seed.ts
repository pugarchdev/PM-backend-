import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Fern & Foley — Projects database...');

  // 1. Clean existing data in dependency order
  await prisma.notification.deleteMany();
  await prisma.changeLogEntry.deleteMany();
  await prisma.statusOverrideLog.deleteMany();
  await prisma.allocation.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.risk.deleteMany();
  await prisma.milestone.deleteMany();
  await prisma.qualityCheck.deleteMany();
  await prisma.task.deleteMany();
  await prisma.phase.deleteMany();
  await prisma.baseline.deleteMany();
  await prisma.projectMembership.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();

  // 2. Create Users
  const ceo = await prisma.user.create({
    data: {
      name: 'Eleanor Foley',
      email: 'eleanor.foley@fernandfoley.internal',
      phone: '+442079460991',
      role: 'CEO',
      department: 'Executive Leadership',
      avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80',
      isSignupCompleted: true,
    } as any,
  });

  const poMarcus = await prisma.user.create({
    data: {
      name: 'Marcus Vance',
      email: 'marcus.vance@fernandfoley.internal',
      phone: '+442079460992',
      role: 'ProjectOwner',
      department: 'Engineering & Operations',
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
      isSignupCompleted: true,
    } as any,
  });

  const poSarah = await prisma.user.create({
    data: {
      name: 'Sarah Chen',
      email: 'sarah.chen@fernandfoley.internal',
      phone: '+442079460993',
      role: 'ProjectOwner',
      department: 'Brand & Supply Chain',
      avatarUrl: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop&q=80',
      isSignupCompleted: true,
    } as any,
  });

  const empDavid = await prisma.user.create({
    data: {
      name: 'David Ross',
      email: 'david.ross@fernandfoley.internal',
      phone: '+442079460994',
      role: 'Employee',
      department: 'Manufacturing Operations',
      avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
      isSignupCompleted: true,
    } as any,
  });

  const empAmara = await prisma.user.create({
    data: {
      name: 'Amara Diallo',
      email: 'amara.diallo@fernandfoley.internal',
      phone: '+442079460995',
      role: 'Employee',
      department: 'Food Safety & QA',
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
      isSignupCompleted: true,
    } as any,
  });

  const empLiam = await prisma.user.create({
    data: {
      name: 'Liam Thorne',
      email: 'liam.thorne@fernandfoley.internal',
      phone: '+442079460996',
      role: 'Employee',
      department: 'Logistics & Warehouse',
      avatarUrl: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&auto=format&fit=crop&q=80',
      isSignupCompleted: true,
    } as any,
  });

  console.log('Created 6 users.');

  // Reference dates relative to current local time (September 2026)
  const now = new Date('2026-09-16T12:00:00Z');

  // Helper for dates
  const makeDate = (dateStr: string) => new Date(dateStr);

  // 3. Project 1: Oat Mill Line 3 (Marcus Vance)
  const proj1 = await prisma.project.create({
    data: {
      name: 'Oat Mill Line 3',
      goal: 'Expand fine milling capacity to 4,200 tons/month to support European retailer demand and prevent seasonal shortages.',
      ownerId: poMarcus.id,
      sponsor: 'Eleanor Foley',
      startDate: makeDate('2026-06-01T00:00:00Z'),
      endDate: makeDate('2026-11-30T00:00:00Z'),
      plannedBudget: 1850000,
      contingency: 185000,
      spendToDate: 840000,
      statusOverride: null, // Natural calculation
    },
  });

  // Project 1 Memberships
  await prisma.projectMembership.createMany({
    data: [
      { projectId: proj1.id, userId: poMarcus.id, role: 'Owner' },
      { projectId: proj1.id, userId: empDavid.id, role: 'Member' },
      { projectId: proj1.id, userId: empAmara.id, role: 'Member' },
    ],
  });

  // Project 1 Phases
  const p1Ph1 = await prisma.phase.create({
    data: {
      projectId: proj1.id,
      name: 'Civil Works & Floor Reinforcement',
      plannedStart: makeDate('2026-06-01T00:00:00Z'),
      plannedEnd: makeDate('2026-07-20T00:00:00Z'),
      order: 1,
    },
  });

  const p1Ph2 = await prisma.phase.create({
    data: {
      projectId: proj1.id,
      name: 'Milling Equipment Installation',
      plannedStart: makeDate('2026-07-21T00:00:00Z'),
      plannedEnd: makeDate('2026-09-30T00:00:00Z'),
      order: 2,
    },
  });

  const p1Ph3 = await prisma.phase.create({
    data: {
      projectId: proj1.id,
      name: 'Electrical & Scada Automation',
      plannedStart: makeDate('2026-10-01T00:00:00Z'),
      plannedEnd: makeDate('2026-11-10T00:00:00Z'),
      order: 3,
    },
  });

  const p1Ph4 = await prisma.phase.create({
    data: {
      projectId: proj1.id,
      name: 'HACCP Validation & Pilot Run',
      plannedStart: makeDate('2026-11-11T00:00:00Z'),
      plannedEnd: makeDate('2026-11-30T00:00:00Z'),
      order: 4,
    },
  });

  // Baseline for Project 1
  const b1 = await prisma.baseline.create({
    data: {
      projectId: proj1.id,
      name: 'Initial Project Approval Baseline',
      approvedBy: ceo.id,
      dataSnapshot: JSON.stringify({
        budget: 1850000,
        phases: ['Civil Works', 'Equipment Install', 'Electrical & Automation', 'HACCP Validation'],
      }),
    },
  });
  await prisma.project.update({
    where: { id: proj1.id },
    data: { baselineId: b1.id },
  });

  // Tasks for Phase 1 (Completed)
  const t1_1 = await prisma.task.create({
    data: {
      phaseId: p1Ph1.id,
      title: 'Excavate and reinforce foundation slabs for heavy rollers',
      assigneeId: empDavid.id,
      priority: 'High',
      plannedStart: makeDate('2026-06-01T00:00:00Z'),
      plannedEnd: makeDate('2026-06-25T00:00:00Z'),
      plannedHours: 80,
      actualHours: 84,
      state: 'Completed',
      isBaselined: true,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t1_1.id,
      label: 'Structural engineer core test load sign-off (C35 concrete)',
      mandatory: true,
      checkedBy: empDavid.id,
      checkedAt: makeDate('2026-06-24T14:00:00Z'),
    },
  });

  const t1_2 = await prisma.task.create({
    data: {
      phaseId: p1Ph1.id,
      title: 'Install epoxy hygienic floor coating and perimeter bunding',
      assigneeId: empDavid.id,
      priority: 'Normal',
      plannedStart: makeDate('2026-06-26T00:00:00Z'),
      plannedEnd: makeDate('2026-07-18T00:00:00Z'),
      plannedHours: 45,
      actualHours: 42,
      state: 'Completed',
      isBaselined: true,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t1_2.id,
      label: 'Anti-slip rating verification (R11 standard)',
      mandatory: true,
      checkedBy: empAmara.id,
      checkedAt: makeDate('2026-07-19T10:00:00Z'),
    },
  });

  // Tasks for Phase 2 (In progress / Active right now in Sept 2026)
  const t1_3 = await prisma.task.create({
    data: {
      phaseId: p1Ph2.id,
      title: 'Rig and mount Bühler de-hulling cyclones onto mezzanine',
      assigneeId: empDavid.id,
      priority: 'High',
      plannedStart: makeDate('2026-07-22T00:00:00Z'),
      plannedEnd: makeDate('2026-08-15T00:00:00Z'),
      plannedHours: 65,
      actualHours: 65,
      state: 'Completed',
      isBaselined: true,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t1_3.id,
      label: 'Laser alignment tolerance check (<0.2mm variance)',
      mandatory: true,
      checkedBy: empDavid.id,
      checkedAt: makeDate('2026-08-14T16:00:00Z'),
    },
  });

  const t1_4 = await prisma.task.create({
    data: {
      phaseId: p1Ph2.id,
      title: 'Assemble roller mills and acoustic dampening mounts',
      assigneeId: empDavid.id,
      priority: 'High',
      plannedStart: makeDate('2026-08-16T00:00:00Z'),
      plannedEnd: makeDate('2026-09-18T00:00:00Z'),
      plannedHours: 90,
      actualHours: 72,
      state: 'In progress',
      isBaselined: true,
      dependsOn: t1_3.id,
    },
  });
  await prisma.qualityCheck.createMany({
    data: [
      {
        taskId: t1_4.id,
        label: 'Vibration dampener torque check to OEM specs',
        mandatory: true,
        checkedBy: empDavid.id,
        checkedAt: makeDate('2026-09-12T11:00:00Z'),
      },
      {
        taskId: t1_4.id,
        label: 'Secondary emergency stop trip switch test',
        mandatory: true,
        checkedBy: null,
        checkedAt: null,
      },
    ],
  });

  const t1_5 = await prisma.task.create({
    data: {
      phaseId: p1Ph2.id,
      title: 'Pneumatic grain transfer ductwork & explosion suppression valves',
      assigneeId: empAmara.id,
      priority: 'Normal',
      plannedStart: makeDate('2026-09-01T00:00:00Z'),
      plannedEnd: makeDate('2026-09-28T00:00:00Z'),
      plannedHours: 50,
      actualHours: 20,
      state: 'In progress',
      isBaselined: true,
      hasRiskFlag: true,
      riskFlagReason: 'Ductwork fabricator delayed by 4 days due to stainless steel stock',
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t1_5.id,
      label: 'ATEX zone 20 explosion vent certification',
      mandatory: true,
      checkedBy: null,
      checkedAt: null,
    },
  });

  // Future tasks Phase 3 & 4
  const t1_6 = await prisma.task.create({
    data: {
      phaseId: p1Ph3.id,
      title: 'Wire 400V 3-phase supply and main variable frequency drives',
      assigneeId: empDavid.id,
      priority: 'Normal',
      plannedStart: makeDate('2026-10-01T00:00:00Z'),
      plannedEnd: makeDate('2026-10-20T00:00:00Z'),
      plannedHours: 60,
      actualHours: 0,
      state: 'Not started',
      isBaselined: true,
      dependsOn: t1_4.id,
    },
  });

  const t1_7 = await prisma.task.create({
    data: {
      phaseId: p1Ph4.id,
      title: 'Run 50-tonne clean grain commissioning batch through sieves',
      assigneeId: empAmara.id,
      priority: 'High',
      plannedStart: makeDate('2026-11-12T00:00:00Z'),
      plannedEnd: makeDate('2026-11-25T00:00:00Z'),
      plannedHours: 40,
      actualHours: 0,
      state: 'Not started',
      isBaselined: true,
      dependsOn: t1_6.id,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t1_7.id,
      label: 'Microbiology test negative for salmonella/mycotoxins',
      mandatory: true,
      checkedBy: null,
      checkedAt: null,
    },
  });

  // Project 1 Milestones
  await prisma.milestone.createMany({
    data: [
      {
        projectId: proj1.id,
        title: 'Foundations & Civil Works Complete',
        baselineDate: makeDate('2026-07-20T00:00:00Z'),
        forecastDate: makeDate('2026-07-20T00:00:00Z'),
        actualDate: makeDate('2026-07-19T00:00:00Z'),
      },
      {
        projectId: proj1.id,
        title: 'Milling Equipment Mechanical Completion',
        baselineDate: makeDate('2026-09-30T00:00:00Z'),
        forecastDate: makeDate('2026-10-02T00:00:00Z'),
        actualDate: null,
      },
      {
        projectId: proj1.id,
        title: 'Full Plant SCADA Integration',
        baselineDate: makeDate('2026-11-10T00:00:00Z'),
        forecastDate: makeDate('2026-11-12T00:00:00Z'),
        actualDate: null,
      },
      {
        projectId: proj1.id,
        title: 'Commercial Production Go-Live',
        baselineDate: makeDate('2026-11-30T00:00:00Z'),
        forecastDate: makeDate('2026-11-30T00:00:00Z'),
        actualDate: null,
      },
    ],
  });

  // Project 1 Issues
  await prisma.issue.createMany({
    data: [
      {
        projectId: proj1.id,
        taskId: t1_5.id,
        title: 'Ductwork elbow weld defects identified on delivery batch B',
        severity: 'Major',
        state: 'In progress',
        ownerId: poMarcus.id,
        detail: 'Ultrasound testing by QA detected non-penetrating welds on 3 stainless bends. Replacement parts dispatched on priority freight.',
        raisedBy: empAmara.id,
        raisedAt: makeDate('2026-09-10T09:30:00Z'),
      },
      {
        projectId: proj1.id,
        taskId: t1_1.id,
        title: 'Temporary water main shutoff during trenching',
        severity: 'Minor',
        state: 'Closed',
        ownerId: poMarcus.id,
        detail: 'Line re-pressurized after 3 hours. Water tanker supplied cooling towers.',
        raisedBy: empDavid.id,
        raisedAt: makeDate('2026-06-12T11:00:00Z'),
        closedAt: makeDate('2026-06-12T16:30:00Z'),
      },
    ],
  });

  // Project 1 Risks
  await prisma.risk.createMany({
    data: [
      {
        projectId: proj1.id,
        taskId: t1_6.id,
        description: 'Lead time for Schneider 250A contactor panel may exceed 8 weeks due to European component backlog.',
        severity: 'High',
        mitigation: 'Pre-ordered alternative ABB certified equivalent with supplier expedited freight guarantee.',
        ownerId: poMarcus.id,
        lastReviewedAt: makeDate('2026-09-14T10:00:00Z'),
      },
      {
        projectId: proj1.id,
        taskId: null,
        description: 'Power grid substation tie-in scheduled during regional weekend maintenance window.',
        severity: 'Medium',
        mitigation: 'Coordinated with UK Power Networks; mobile generator on standby.',
        ownerId: poMarcus.id,
        lastReviewedAt: makeDate('2026-09-02T15:00:00Z'),
      },
    ],
  });

  // 4. Project 2: Packaging Refresh (Sarah Chen)
  const proj2 = await prisma.project.create({
    data: {
      name: 'Packaging Refresh',
      goal: 'Transition all retail oat porridge and granola SKUs to 100% compostable barrier film with FSC certified paperboard.',
      ownerId: poSarah.id,
      sponsor: 'Eleanor Foley',
      startDate: makeDate('2026-05-15T00:00:00Z'),
      endDate: makeDate('2026-10-15T00:00:00Z'),
      plannedBudget: 420000,
      contingency: 42000,
      spendToDate: 310000,
      statusOverride: null, // Natural calculation
    },
  });

  await prisma.projectMembership.createMany({
    data: [
      { projectId: proj2.id, userId: poSarah.id, role: 'Owner' },
      { projectId: proj2.id, userId: empAmara.id, role: 'Member' },
    ],
  });

  const p2Ph1 = await prisma.phase.create({
    data: {
      projectId: proj2.id,
      name: 'Barrier Film Formulation & Trial',
      plannedStart: makeDate('2026-05-15T00:00:00Z'),
      plannedEnd: makeDate('2026-07-15T00:00:00Z'),
      order: 1,
    },
  });

  const p2Ph2 = await prisma.phase.create({
    data: {
      projectId: proj2.id,
      name: 'Retail Artwork & Print Plates',
      plannedStart: makeDate('2026-07-16T00:00:00Z'),
      plannedEnd: makeDate('2026-09-10T00:00:00Z'),
      order: 2,
    },
  });

  const p2Ph3 = await prisma.phase.create({
    data: {
      projectId: proj2.id,
      name: 'Packing Machine Seal Jaws Retrofit',
      plannedStart: makeDate('2026-09-11T00:00:00Z'),
      plannedEnd: makeDate('2026-10-15T00:00:00Z'),
      order: 3,
    },
  });

  const t2_1 = await prisma.task.create({
    data: {
      phaseId: p2Ph1.id,
      title: 'Moisture barrier oxygen transmission rate testing in accelerated climate chamber',
      assigneeId: empAmara.id,
      priority: 'High',
      plannedStart: makeDate('2026-05-20T00:00:00Z'),
      plannedEnd: makeDate('2026-06-30T00:00:00Z'),
      plannedHours: 60,
      actualHours: 65,
      state: 'Completed',
      isBaselined: true,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t2_1.id,
      label: 'OTR < 1.5 cc/m²/day certified by Campden BRI lab',
      mandatory: true,
      checkedBy: empAmara.id,
      checkedAt: makeDate('2026-06-29T14:30:00Z'),
    },
  });

  const t2_2 = await prisma.task.create({
    data: {
      phaseId: p2Ph2.id,
      title: 'Finalize flexographic plate proofs with printer for 12 SKU lineup',
      assigneeId: poSarah.id,
      priority: 'Normal',
      plannedStart: makeDate('2026-07-20T00:00:00Z'),
      plannedEnd: makeDate('2026-08-25T00:00:00Z'),
      plannedHours: 40,
      actualHours: 44,
      state: 'Completed',
      isBaselined: true,
    },
  });

  const t2_3 = await prisma.task.create({
    data: {
      phaseId: p2Ph3.id,
      title: 'CNC machine Teflon-coated ultrasonic seal jaws for Bosch bagging line',
      assigneeId: empAmara.id,
      priority: 'High',
      plannedStart: makeDate('2026-09-12T00:00:00Z'),
      plannedEnd: makeDate('2026-10-05T00:00:00Z'),
      plannedHours: 50,
      actualHours: 15,
      state: 'In progress',
      isBaselined: true,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t2_3.id,
      label: 'Zero pinhole leakage under 0.8 bar underwater burst test',
      mandatory: true,
      checkedBy: null,
      checkedAt: null,
    },
  });

  // Project 2 Milestones
  await prisma.milestone.createMany({
    data: [
      {
        projectId: proj2.id,
        title: 'Barrier Formulation Approval',
        baselineDate: makeDate('2026-07-15T00:00:00Z'),
        forecastDate: makeDate('2026-07-15T00:00:00Z'),
        actualDate: makeDate('2026-07-14T00:00:00Z'),
      },
      {
        projectId: proj2.id,
        title: 'Pre-Print Sign-Off All Retail SKUs',
        baselineDate: makeDate('2026-09-10T00:00:00Z'),
        forecastDate: makeDate('2026-09-12T00:00:00Z'),
        actualDate: makeDate('2026-09-12T00:00:00Z'),
      },
      {
        projectId: proj2.id,
        title: 'National Distribution Rollout',
        baselineDate: makeDate('2026-10-15T00:00:00Z'),
        forecastDate: makeDate('2026-10-20T00:00:00Z'),
        actualDate: null,
      },
    ],
  });

  // Project 2 Risks & Issues
  await prisma.risk.createMany({
    data: [
      {
        projectId: proj2.id,
        taskId: t2_3.id,
        description: 'New compostable film has narrower sealing temperature window (±3°C) compared to fossil plastic.',
        severity: 'High',
        mitigation: 'Installed precision PID digital temperature controllers on sealing heads.',
        ownerId: poSarah.id,
        lastReviewedAt: makeDate('2026-09-15T11:00:00Z'),
      },
    ],
  });

  // 5. Project 3: Ashford Warehouse Move (Marcus Vance)
  const proj3 = await prisma.project.create({
    data: {
      name: 'Ashford Warehouse Move',
      goal: 'Consolidate 3 regional storage units into a single high-bay 8,500-pallet automated facility in Ashford.',
      ownerId: poMarcus.id,
      sponsor: 'Eleanor Foley',
      startDate: makeDate('2026-07-01T00:00:00Z'),
      endDate: makeDate('2026-12-20T00:00:00Z'),
      plannedBudget: 980000,
      contingency: 98000,
      spendToDate: 410000,
      statusOverride: null,
    },
  });

  await prisma.projectMembership.createMany({
    data: [
      { projectId: proj3.id, userId: poMarcus.id, role: 'Owner' },
      { projectId: proj3.id, userId: empDavid.id, role: 'Member' },
      { projectId: proj3.id, userId: empLiam.id, role: 'Member' },
    ],
  });

  const p3Ph1 = await prisma.phase.create({
    data: {
      projectId: proj3.id,
      name: 'Racking Installation & Wire Guidance',
      plannedStart: makeDate('2026-07-01T00:00:00Z'),
      plannedEnd: makeDate('2026-08-31T00:00:00Z'),
      order: 1,
    },
  });

  const p3Ph2 = await prisma.phase.create({
    data: {
      projectId: proj3.id,
      name: 'WMS Scanning Network & Forklift Fleet',
      plannedStart: makeDate('2026-09-01T00:00:00Z'),
      plannedEnd: makeDate('2026-10-31T00:00:00Z'),
      order: 2,
    },
  });

  const t3_1 = await prisma.task.create({
    data: {
      phaseId: p3Ph1.id,
      title: 'Erect narrow-aisle heavy pallet racking rows 1-28',
      assigneeId: empDavid.id,
      priority: 'Normal',
      plannedStart: makeDate('2026-07-05T00:00:00Z'),
      plannedEnd: makeDate('2026-08-20T00:00:00Z'),
      plannedHours: 120,
      actualHours: 115,
      state: 'Completed',
      isBaselined: true,
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t3_1.id,
      label: 'SEMA independent rack inspection load test pass',
      mandatory: true,
      checkedBy: empDavid.id,
      checkedAt: makeDate('2026-08-21T09:00:00Z'),
    },
  });

  const t3_2 = await prisma.task.create({
    data: {
      phaseId: p3Ph2.id,
      title: 'Deploy ruggedized Zebra RFID/Barcode RF network access points',
      assigneeId: empLiam.id,
      priority: 'Normal',
      plannedStart: makeDate('2026-09-05T00:00:00Z'),
      plannedEnd: makeDate('2026-09-30T00:00:00Z'),
      plannedHours: 45,
      actualHours: 25,
      state: 'In progress',
      isBaselined: true,
    },
  });

  await prisma.milestone.createMany({
    data: [
      {
        projectId: proj3.id,
        title: 'Racking Sign-Off',
        baselineDate: makeDate('2026-08-31T00:00:00Z'),
        forecastDate: makeDate('2026-08-31T00:00:00Z'),
        actualDate: makeDate('2026-08-28T00:00:00Z'),
      },
      {
        projectId: proj3.id,
        title: 'Full Stock Relocation Cutover',
        baselineDate: makeDate('2026-12-15T00:00:00Z'),
        forecastDate: makeDate('2026-12-15T00:00:00Z'),
        actualDate: null,
      },
    ],
  });

  // 6. Project 4: Trade Ordering Portal (Sarah Chen) - OFF_TRACK due to Critical Issue
  const proj4 = await prisma.project.create({
    data: {
      name: 'Trade Ordering Portal',
      goal: 'Self-service wholesale portal enabling 450+ retail stockists to order pallet quantities with automated credit checks.',
      ownerId: poSarah.id,
      sponsor: 'Eleanor Foley',
      startDate: makeDate('2026-08-01T00:00:00Z'),
      endDate: makeDate('2026-12-15T00:00:00Z'),
      plannedBudget: 310000,
      contingency: 31000,
      spendToDate: 125000,
      statusOverride: null, // Natural calculation: has Critical issue -> OFF_TRACK!
    },
  });

  await prisma.projectMembership.createMany({
    data: [
      { projectId: proj4.id, userId: poSarah.id, role: 'Owner' },
      { projectId: proj4.id, userId: empLiam.id, role: 'Member' },
    ],
  });

  const p4Ph1 = await prisma.phase.create({
    data: {
      projectId: proj4.id,
      name: 'ERP / EDI Gateway Integration',
      plannedStart: makeDate('2026-08-01T00:00:00Z'),
      plannedEnd: makeDate('2026-09-25T00:00:00Z'),
      order: 1,
    },
  });

  const p4Ph2 = await prisma.phase.create({
    data: {
      projectId: proj4.id,
      name: 'Stockist User Acceptance Testing',
      plannedStart: makeDate('2026-09-26T00:00:00Z'),
      plannedEnd: makeDate('2026-11-15T00:00:00Z'),
      order: 2,
    },
  });

  const t4_1 = await prisma.task.create({
    data: {
      phaseId: p4Ph1.id,
      title: 'Build synchronous SOAP-to-REST adapter for legacy Sage Enterprise ERP',
      assigneeId: empLiam.id,
      priority: 'High',
      plannedStart: makeDate('2026-08-05T00:00:00Z'),
      plannedEnd: makeDate('2026-09-20T00:00:00Z'),
      plannedHours: 85,
      actualHours: 80,
      state: 'Blocked',
      isBaselined: true,
      hasRiskFlag: true,
      riskFlagReason: 'ERP server connection dropping under concurrent load',
    },
  });
  await prisma.qualityCheck.create({
    data: {
      taskId: t4_1.id,
      label: 'End-to-end sandbox order creation with mock credit limit validation',
      mandatory: true,
      checkedBy: null,
      checkedAt: null,
    },
  });

  // CRITICAL ISSUE for Project 4 (Makes status OFF_TRACK!)
  await prisma.issue.create({
    data: {
      projectId: proj4.id,
      taskId: t4_1.id,
      title: 'Sage ERP API gateway timeout on inventory allocation requests',
      severity: 'Critical',
      state: 'Open',
      ownerId: poSarah.id,
      detail: 'Concurrent order dispatch fails with 504 Gateway Timeout whenever more than 5 users checkout simultaneously. Blocker for UAT rollout.',
      raisedBy: empLiam.id,
      raisedAt: makeDate('2026-09-14T15:20:00Z'),
    },
  });

  await prisma.risk.create({
    data: {
      projectId: proj4.id,
      taskId: t4_1.id,
      description: 'Legacy Sage middleware database lockup during peak trading hours.',
      severity: 'High',
      mitigation: 'Engaging external ERP infrastructure consultants for index tuning.',
      ownerId: poSarah.id,
      lastReviewedAt: makeDate('2026-09-15T09:00:00Z'),
    },
  });

  await prisma.milestone.createMany({
    data: [
      {
        projectId: proj4.id,
        title: 'ERP Integration Verified',
        baselineDate: makeDate('2026-09-25T00:00:00Z'),
        forecastDate: makeDate('2026-10-10T00:00:00Z'),
        actualDate: null,
      },
      {
        projectId: proj4.id,
        title: 'Pilot Stockist Go-Live',
        baselineDate: makeDate('2026-12-15T00:00:00Z'),
        forecastDate: makeDate('2026-12-28T00:00:00Z'),
        actualDate: null,
      },
    ],
  });

  // 7. Allocations for Workload Screen
  // 37-hour standard reference week
  const thisWeek = makeDate('2026-09-14T00:00:00Z');

  // Marcus Vance: 38 hours (>100% -> OVER - red)
  await prisma.allocation.createMany({
    data: [
      { userId: poMarcus.id, projectId: proj1.id, weekStartDate: thisWeek, allocatedHours: 26 },
      { userId: poMarcus.id, projectId: proj3.id, weekStartDate: thisWeek, allocatedHours: 14 }, // total 40 hrs
    ],
  });

  // Sarah Chen: 34 hours (91.8% -> BALANCED - amber)
  await prisma.allocation.createMany({
    data: [
      { userId: poSarah.id, projectId: proj2.id, weekStartDate: thisWeek, allocatedHours: 18 },
      { userId: poSarah.id, projectId: proj4.id, weekStartDate: thisWeek, allocatedHours: 16 }, // total 34 hrs
    ],
  });

  // David Ross: 41 hours (>100% -> OVER - red)
  await prisma.allocation.createMany({
    data: [
      { userId: empDavid.id, projectId: proj1.id, weekStartDate: thisWeek, allocatedHours: 25 },
      { userId: empDavid.id, projectId: proj3.id, weekStartDate: thisWeek, allocatedHours: 16 }, // total 41 hrs
    ],
  });

  // Amara Diallo: 30 hours (81% -> BALANCED - amber)
  await prisma.allocation.createMany({
    data: [
      { userId: empAmara.id, projectId: proj1.id, weekStartDate: thisWeek, allocatedHours: 14 },
      { userId: empAmara.id, projectId: proj2.id, weekStartDate: thisWeek, allocatedHours: 16 }, // total 30 hrs
    ],
  });

  // Liam Thorne: 22 hours (59% -> AVAILABLE - green)
  await prisma.allocation.createMany({
    data: [
      { userId: empLiam.id, projectId: proj3.id, weekStartDate: thisWeek, allocatedHours: 10 },
      { userId: empLiam.id, projectId: proj4.id, weekStartDate: thisWeek, allocatedHours: 12 }, // total 22 hrs
    ],
  });

  // 8. Notifications for Alerts screen
  await prisma.notification.createMany({
    data: [
      {
        userId: ceo.id,
        projectId: proj4.id,
        title: 'Critical Issue Raised',
        message: 'Trade Ordering Portal: Sage ERP API gateway timeout on inventory allocation requests',
        type: 'CRITICAL_ISSUE',
        linkUrl: `/projects/${proj4.id}?tab=issues`,
        createdAt: makeDate('2026-09-14T15:25:00Z'),
      },
      {
        userId: ceo.id,
        projectId: proj1.id,
        title: 'High Risk Flagged',
        message: 'Oat Mill Line 3: Lead time for Schneider 250A contactor panel exceeds 8 weeks',
        type: 'HIGH_RISK',
        linkUrl: `/projects/${proj1.id}?tab=risks`,
        createdAt: makeDate('2026-09-14T10:15:00Z'),
      },
      {
        userId: poMarcus.id,
        projectId: proj1.id,
        title: 'Task Risk Flagged',
        message: 'Pneumatic grain transfer ductwork fabricator delayed by 4 days',
        type: 'TASK_ASSIGNED',
        linkUrl: `/projects/${proj1.id}?tab=tasks`,
        createdAt: makeDate('2026-09-13T16:00:00Z'),
      },
      {
        userId: empDavid.id,
        projectId: proj1.id,
        title: 'Assigned to Roller Mill Assembly',
        message: 'You have been assigned to: Assemble roller mills and acoustic dampening mounts (90 hrs planned)',
        type: 'TASK_ASSIGNED',
        linkUrl: `/projects/${proj1.id}?tab=tasks`,
        createdAt: makeDate('2026-09-12T08:30:00Z'),
      },
      {
        userId: empAmara.id,
        projectId: proj1.id,
        title: 'Quality Check Required',
        message: 'Mandatory ATEX zone 20 explosion vent certification awaiting inspection',
        type: 'QUALITY_CHECK',
        linkUrl: `/projects/${proj1.id}?tab=tasks`,
        createdAt: makeDate('2026-09-11T14:00:00Z'),
      },
      {
        userId: empLiam.id,
        projectId: proj4.id,
        title: 'Task Blocked',
        message: 'Build synchronous SOAP adapter is blocked by Sage ERP timeout',
        type: 'BLOCKED_TASK',
        linkUrl: `/projects/${proj4.id}?tab=tasks`,
        createdAt: makeDate('2026-09-14T15:30:00Z'),
      },
    ],
  });

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
