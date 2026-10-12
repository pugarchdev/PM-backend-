import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CEO_DATA = {
  name: 'Eleanor Foley',
  email: 'eleanor.foley@fernandfoley.internal',
  phone: '+442079460991',
  role: 'CEO' as const,
  department: 'Executive Leadership',
  avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80',
  isSignupCompleted: true,
};

async function main() {
  console.log('--- CEO Account Creation ---');

  // 1. Check if ANY CEO account already exists in the database
  const existingCeo = await prisma.user.findFirst({
    where: { role: 'CEO' },
  });

  if (existingCeo) {
    console.log('\n[INFO] A CEO account already exists in the database. No changes made.');
    console.log(`  - Name:       ${existingCeo.name}`);
    console.log(`  - Email:      ${existingCeo.email}`);
    console.log(`  - Role:       ${existingCeo.role}`);
    console.log(`  - Department: ${existingCeo.department || 'N/A'}`);
    console.log(`  - User ID:    ${existingCeo.id}`);
    console.log('\n[LOGIN] You can log in using either:');
    console.log(`  1. Directory selection: Select "${existingCeo.name} (CEO)" from the login dropdown.`);
    console.log(`  2. Email sign-in: Enter "${existingCeo.email}" in the Email tab.`);
    return;
  }

  // 2. Check if a user with the target email already exists with a different role
  const existingEmailUser = await prisma.user.findUnique({
    where: { email: CEO_DATA.email },
  });

  if (existingEmailUser) {
    console.log(`\n[INFO] User with email "${CEO_DATA.email}" found with role "${existingEmailUser.role}". Promoting to CEO...`);
    const updatedUser = await prisma.user.update({
      where: { id: existingEmailUser.id },
      data: {
        role: 'CEO',
        department: CEO_DATA.department,
        name: existingEmailUser.name || CEO_DATA.name,
        avatarUrl: existingEmailUser.avatarUrl || CEO_DATA.avatarUrl,
        phone: (existingEmailUser as any).phone || CEO_DATA.phone,
        isSignupCompleted: true,
      } as any,
    });
    console.log('\n[SUCCESS] User successfully promoted to CEO:');
    console.log(`  - Name:       ${updatedUser.name}`);
    console.log(`  - Email:      ${updatedUser.email}`);
    console.log(`  - Role:       ${updatedUser.role}`);
    console.log(`  - Department: ${updatedUser.department}`);
    console.log(`  - User ID:    ${updatedUser.id}`);
    console.log('\n[LOGIN] Credentials for sign-in:');
    console.log(`  - Email:   ${updatedUser.email}`);
    console.log(`  - User ID: ${updatedUser.id}`);
    return;
  }

  // 3. Create the single standalone CEO account (no projects, tasks, or dummy data)
  const newCeo = await prisma.user.create({
    data: CEO_DATA as any,
  });

  console.log('\n[SUCCESS] CEO account created successfully:');
  console.log(`  - Name:       ${newCeo.name}`);
  console.log(`  - Email:      ${newCeo.email}`);
  console.log(`  - Role:       ${newCeo.role}`);
  console.log(`  - Department: ${newCeo.department}`);
  console.log(`  - User ID:    ${newCeo.id}`);
  console.log('\n[LOGIN] Credentials for sign-in:');
  console.log(`  - Email:   ${newCeo.email}`);
  console.log(`  - User ID: ${newCeo.id}`);
  console.log('  - Note: Fern & Foley uses passwordless email / directory-based authentication.');
}

main()
  .catch((error) => {
    console.error('[ERROR] Failed to create CEO account:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
