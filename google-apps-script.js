// ============================================================
// PASTE THIS ENTIRE FILE INTO Google Apps Script
// Go to: script.google.com → New Project → paste this → Save
// Then: Deploy → New Deployment → Web App → Anyone → Deploy
// Copy the URL and paste it into your .env as GOOGLE_APPS_SCRIPT_URL
// ============================================================

const SHEET_NAME = 'Macros'; // Change if your sheet tab has a different name

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Get or create the sheet
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
    }
    
    // Add header row if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Date', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Fiber (g)', 'Meals']);
      
      // Style the header row
      const headerRange = sheet.getRange(1, 1, 1, 7);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#4a90d9');
      headerRange.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
    
    // Check if there's already an entry for this date and update it
    const lastRow = sheet.getLastRow();
    let existingRow = -1;
    if (lastRow > 1) {
      const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < dates.length; i++) {
        if (dates[i][0] === data.date) {
          existingRow = i + 2; // +2 because 1-indexed and header row
          break;
        }
      }
    }
    
    const rowData = [
      data.date,
      data.calories,
      data.protein,
      data.carbs,
      data.fat,
      data.fiber,
      data.meals
    ];
    
    if (existingRow > -1) {
      // Update existing row
      sheet.getRange(existingRow, 1, 1, 7).setValues([rowData]);
    } else {
      // Append new row
      sheet.appendRow(rowData);
    }
    
    // Auto-resize columns for readability
    sheet.autoResizeColumns(1, 7);
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Test function - run this manually in the script editor to verify the sheet works
function testAppend() {
  const testData = {
    postData: {
      contents: JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        calories: 1850,
        protein: 145,
        carbs: 180,
        fat: 62,
        fiber: 28,
        meals: 'Test meal 1, Test meal 2'
      })
    }
  };
  const result = doPost(testData);
  Logger.log(result.getContent());
}