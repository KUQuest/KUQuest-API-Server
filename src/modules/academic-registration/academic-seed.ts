import { db } from '@/database/client';
import { department, faculty } from '@/database/schema/academic.schema';

export type AcademicCatalogEntry = {
  faculty: string;
  departments: readonly string[];
};

export const academicCatalog: readonly AcademicCatalogEntry[] = [
  {
    faculty: 'Agriculture',
    departments: [
      'Agricultural Extension and Communication',
      'Agronomy',
      'Animal Science',
      'Entomology',
      'Farm Mechanics',
      'Home Economics',
      'Horticulture',
      'Plant Pathology',
      'Soil Science',
      'Tropical Agriculture',
    ],
  },
  {
    faculty: 'Business Administration',
    departments: [
      'Accounting',
      'Bachelor of Accountancy',
      'Business Administration',
      'Finance',
      'Management',
      'Marketing',
      'Technology and Operations Management',
    ],
  },
  {
    faculty: 'Fisheries',
    departments: [
      'Aquaculture',
      'Fisheries Biology',
      'Fisheries Management',
      'Fisheries Technology and Innovation',
      'Fishery Products',
      'Marine Science',
    ],
  },
  {
    faculty: 'Humanities',
    departments: [
      'Communication Arts and Information Science',
      'Communicative Thai Language for Foreigners',
      'Eastern Languages',
      'Foreign Languages',
      'Integrated Tourism Management',
      'Linguistics',
      'Literature',
      'Music',
      'Philosophy and Religion',
      'Thai Language',
      'Tourism and Hospitality Industry',
    ],
  },
  {
    faculty: 'Forestry',
    departments: [
      'Conservation',
      'Forest Biology',
      'Forest Engineering',
      'Forest Management',
      'Forest Products',
      'Forestry',
      'Silviculture',
    ],
  },
  {
    faculty: 'Science',
    departments: [
      'Applied Radiation and Isotopes',
      'Biochemistry',
      'Bioscience and Technology',
      'Botany',
      'Chemistry',
      'Computer Science',
      'Earth Science',
      'Genetics',
      'Integrated Chemistry',
      'Materials Science',
      'Mathematics',
      'Microbiology',
      'Physics',
      'Polymer Science and Technology',
      'Statistics',
      'Zoology',
    ],
  },
  {
    faculty: 'Engineering',
    departments: [
      'Aerospace Engineering',
      'Aerospace Engineering and Business Management',
      'Chemical Engineering',
      'Civil Engineering',
      'Computer Engineering',
      'Digital Manufacturing and Robotics Integration Engineering',
      'Electrical Engineering',
      'Engineering',
      'Environmental Engineering',
      'Industrial Engineering',
      'Materials Engineering',
      'Mechanical Engineering',
      'Software and Knowledge Engineering',
      'Water Resources Engineering',
    ],
  },
  {
    faculty: 'Education',
    departments: [
      'Education',
      'Educational Psychology and Guidance',
      'Educational Technology',
      'Physical Education',
      'Vocational Education',
    ],
  },
  {
    faculty: 'Economics',
    departments: [
      'Agricultural and Resource Economics',
      'Cooperatives',
      'Economics',
      'Entrepreneurial Economics',
    ],
  },
  {
    faculty: 'Architecture',
    departments: ['Architecture', 'Building Innovation', 'Landscape Architecture'],
  },
  {
    faculty: 'Social Sciences',
    departments: [
      'Geography',
      'History',
      'Law',
      'Political Science',
      'Political Science and Public Administration',
      'Psychology',
      'Sociology and Anthropology',
      'Southeast Asian Studies',
    ],
  },
  {
    faculty: 'Veterinary Medicine',
    departments: [
      'Anatomy',
      'Companion Animal Clinical Sciences',
      'Farm Animal Production and Resource Medicine',
      'Large Animal and Wildlife Clinical Sciences',
      'Microbiology and Immunology',
      'Parasitology',
      'Pathology',
      'Pharmacology',
      'Physiology',
      'Veterinary Medicine',
      'Veterinary Public Health',
    ],
  },
  {
    faculty: 'Agro-Industry',
    departments: [
      'Agro-Industrial Innovation and Technology',
      'Agro-Industrial Technology',
      'Biotechnology',
      'Food Science and Technology',
      'Packaging and Materials Technology',
      'Product Development',
      'Textile Science',
    ],
  },
  {
    faculty: 'Veterinary Technology',
    departments: ['Animal Nursing', 'Veterinary Technology'],
  },
  {
    faculty: 'Environment',
    departments: ['Environmental Science', 'Environmental Technology and Management'],
  },
  {
    faculty: 'Medicine',
    departments: [
      'Anatomy',
      'Biochemistry and Genetic Engineering',
      'Clinical Pathology',
      'Medicine',
      'Microbiology',
      'Parasitology',
      'Pathology',
      'Pharmacology',
      'Physiology',
    ],
  },
  {
    faculty: 'Nurse',
    departments: [
      'Adult and Gerontological Nursing',
      'Community and Environmental Health Nursing',
      'Fundamentals of Nursing',
      'Maternal-Newborn and Midwifery Nursing',
      'Mental Health and Psychiatric Nursing',
      'Nursing',
      'Pediatric Nursing',
    ],
  },
  {
    faculty: 'Pharmaceutical Sciences',
    departments: ['Pharmaceutical Sciences', 'Pharmacy Practice'],
  },
  {
    faculty: 'Interdisciplinary Management and Technology',
    departments: [
      'Agricultural Management',
      'Health Management',
      'Hospitality Business Management',
      'Interdisciplinary Management and Technology',
    ],
  },
  {
    faculty: 'School of Integrated Science (SIS)',
    departments: ['Knowledge of The Land for Sustainable Development'],
  },
  {
    faculty: 'International College',
    departments: ['International Undergraduate Programs'],
  },
  {
    faculty: 'Graduate School',
    departments: [
      'Agricultural Biotechnology',
      'Sustainable Land Use and Natural Resource Management',
    ],
  },
] as const;

export const seedAcademicOptions = async (): Promise<{
  faculties: number;
  departments: number;
}> =>
  db.transaction(async (tx) => {
    await tx
      .insert(faculty)
      .values(academicCatalog.map((entry) => ({ name: entry.faculty })))
      .onConflictDoNothing({ target: faculty.name });

    const currentFaculties = await tx.select({ id: faculty.id, name: faculty.name }).from(faculty);
    const facultyMap = new Map(currentFaculties.map((f) => [f.name, f.id]));

    const departmentRowsToInsert: Array<{ facultyId: string; name: string }> = [];

    for (const entry of academicCatalog) {
      const facultyId = facultyMap.get(entry.faculty);
      if (!facultyId) continue;

      for (const deptName of entry.departments) {
        departmentRowsToInsert.push({ facultyId, name: deptName });
      }
    }

    if (departmentRowsToInsert.length > 0) {
      await tx
        .insert(department)
        .values(departmentRowsToInsert)
        .onConflictDoNothing({ target: [department.facultyId, department.name] });
    }

    const allFaculties = await tx.select().from(faculty);
    const allDepartments = await tx.select().from(department);

    return {
      faculties: allFaculties.length,
      departments: allDepartments.length,
    };
  });
