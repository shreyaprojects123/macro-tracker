// ============================================================
// PASTE THIS ENTIRE FILE INTO Google Apps Script
// Go to: script.google.com → New Project → paste this → Save
// Then: Deploy → New Deployment → Web App → Anyone → Deploy
// Copy the URL and paste it into your .env as GOOGLE_APPS_SCRIPT_URL
// ============================================================

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Use phone number as sheet tab name, fallback to 'Macros'
    const tabName = data.userPhone ? data.userPhone : 'Macros';
    
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }
    
    // Add header if empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Date', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Fiber (g)', 'Meals']);
      const headerRange = sheet.getRange(1, 1, 1, 7);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#4a90d9');
      headerRange.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }

    // Check if entry for this date already exists → update it
    const lastRow = sheet.getLastRow();
    let existingRow = -1;
    if (lastRow > 1) {
      const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < dates.length; i++) {
        if (dates[i][0] === data.date) {
          existingRow = i + 2;
          break;
        }
      }
    }

    const rowData = [data.date, data.calories, data.protein, 
                     data.carbs, data.fat, data.fiber, data.meals];

    if (existingRow > -1) {
      sheet.getRange(existingRow, 1, 1, 7).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }

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