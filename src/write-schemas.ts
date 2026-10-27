// Enum values from Google Health v4 discovery, checked 2026-10-27.
// https://health.googleapis.com/$discovery/rest?version=v4
export const WRITE_SCHEMAS: Record<string, { fields: string[]; enums: Record<string, string[]> }> = {
  "hydration-log": {
    "fields": [
      "amountConsumed",
      "interval"
    ],
    "enums": {}
  },
  "nutrition-log": {
    "fields": [
      "interval",
      "foodDisplayName",
      "energy",
      "mealType",
      "nutrients"
    ],
    "enums": {}
  },
  "moods": {
    "fields": [
      "valences",
      "moods",
      "sampleTime"
    ],
    "enums": {
      "valences": [
        "VALENCE_UNSPECIFIED",
        "UNPLEASANT",
        "BASELINE",
        "PLEASANT"
      ],
      "moods": [
        "MOOD_UNSPECIFIED",
        "AMAZED",
        "AMUSED",
        "ANGRY",
        "ANNOYED",
        "ANXIOUS",
        "HAPPY",
        "CONTENT",
        "SAD",
        "WORRIED",
        "FRUSTRATED",
        "EXCITED",
        "CALM",
        "STRESSED",
        "ASHAMED",
        "BRAVE",
        "CONFIDENT",
        "DISAPPOINTED",
        "DISCOURAGED",
        "DISGUSTED",
        "DRAINED",
        "EMBARRASSED",
        "GRATEFUL",
        "GUILTY",
        "HOPEFUL",
        "HOPELESS",
        "INDIFFERENT",
        "IRRITATED",
        "JEALOUS",
        "JOYFUL",
        "LONELY",
        "OVERWHELMED",
        "PASSIONATE",
        "PEACEFUL",
        "PROUD",
        "RELIEVED",
        "SATISFIED",
        "SCARED",
        "SURPRISED",
        "ENERGIZED",
        "FATIGUED",
        "VERY_CALM",
        "VERY_STRESSED",
        "NEUTRAL",
        "AFRAID",
        "HURTING",
        "BORED",
        "BITTER",
        "ENVIOUS",
        "CONFUSED",
        "CURIOUS",
        "AWESTRUCK",
        "INSPIRED",
        "LONGING",
        "ACCOMPLISHED",
        "LOVING",
        "COMPASSIONATE",
        "DEPRESSED",
        "GOOD",
        "LOW_ENERGY",
        "OBSESSIVE_THOUGHTS",
        "PANIC",
        "PLAYFUL",
        "PLEASED",
        "SENSITIVE",
        "SLEEPY",
        "SWINGS",
        "UNHAPPY",
        "VERY_SELF_CRITICAL"
      ]
    }
  },
  "symptoms": {
    "fields": [
      "sampleTime",
      "symptoms"
    ],
    "enums": {
      "symptoms": [
        "SYMPTOM_VALUE_UNSPECIFIED",
        "CRAMPS",
        "HEADACHE",
        "TENDER_BREASTS",
        "ACNE",
        "SICK",
        "BLOATED",
        "HOT_FLASHES",
        "PMS",
        "COUGH",
        "FEVER",
        "DIFFICULTY_BREATHING",
        "BACK_PAIN",
        "SHAKINESS",
        "HUNGER",
        "SWEATING",
        "ANXIETY",
        "THIRST",
        "FREQUENT_URINATION",
        "BLURRED_VISION",
        "OTHER",
        "SEX_DRIVE_HIGH",
        "SEX_DRIVE_MEDIUM",
        "SEX_DRIVE_LOW",
        "HEART_PALPITATIONS",
        "FAINTING",
        "CHEST_PAIN",
        "FATIGUE",
        "CONFUSION",
        "DIZZINESS",
        "ABDOMINAL_PAIN",
        "BLADDER_LEAKS",
        "BLEEDING_GUMS",
        "BRAIN_FOG",
        "BURNING_MOUTH",
        "CONSTIPATION",
        "CRAVINGS",
        "DECREASED_APPETITE",
        "DIARRHEA",
        "DRAWING_PAIN",
        "DRY_EYES",
        "DRY_HAIR",
        "DRY_SKIN",
        "EXHAUSTION",
        "FEEL_GOOD",
        "FOOD_AVERSIONS",
        "HAIR_LOSS",
        "HEARTBURN",
        "HYPERPIGMENTATION",
        "INCREASED_APPETITE",
        "INCREASED_APPETITE_V2",
        "INSOMNIA",
        "JOINT_PAIN",
        "LEG_CRAMPS",
        "MILKY_NIPPLE_DISCHARGE",
        "NAUSEA",
        "NIGHT_SWEATS",
        "NORMAL_DIGESTION",
        "NORMAL_STOOL",
        "PERINEUM_PAIN",
        "SLEEPINESS",
        "STRETCH_MARKS",
        "SWELLING",
        "VAGINAL_DRYNESS",
        "VAGINAL_ITCHING",
        "VOMITING"
      ]
    }
  },
  "menstrual-period": {
    "fields": [
      "interval",
      "notes"
    ],
    "enums": {}
  }
};

export const MEAL_TYPES = ["MEAL_TYPE_UNSPECIFIED", "BEFORE_BREAKFAST", "BREAKFAST", "BEFORE_LUNCH", "LUNCH", "BEFORE_DINNER", "DINNER", "AFTER_DINNER", "SNACK", "ANYTIME"];
export const NUTRIENTS = ["NUTRIENT_UNSPECIFIED", "BIOTIN", "CAFFEINE", "CALCIUM", "CHLORIDE", "CARBOHYDRATES", "CHOLESTEROL", "CHROMIUM", "COPPER", "DIETARY_FIBER", "FOLIC_ACID", "IODINE", "IRON", "MAGNESIUM", "MANGANESE", "MOLYBDENUM", "MONOUNSATURATED_FAT", "NIACIN", "PANTOTHENIC_ACID", "PHOSPHORUS", "POLYUNSATURATED_FAT", "POTASSIUM", "PROTEIN", "RIBOFLAVIN", "SATURATED_FAT", "SELENIUM", "SODIUM", "SUGAR", "THIAMIN", "TRANS_FAT", "UNSATURATED_FAT", "VITAMIN_A", "VITAMIN_B12", "VITAMIN_B6", "VITAMIN_C", "VITAMIN_D", "VITAMIN_E", "VITAMIN_K", "ZINC", "FOLATE"];
